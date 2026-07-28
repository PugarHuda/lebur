// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Nox, ebool, euint16, euint256, externalEuint16, externalEuint256} from
    "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import {IERC20ToERC7984Wrapper} from
    "@iexec-nox/nox-confidential-contracts/contracts/interfaces/IERC20ToERC7984Wrapper.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ICurvePool} from "./ICurve.sol";

/// @title Lebur — a confidential uniform-price batch auction that settles against an
///        unmodified Curve StableSwap-NG pool.
///
/// @notice N sealed orders net against each other inside this contract under iExec Nox
///         (Intel TDX). Size, side and limit price are encrypted end to end. The only
///         quantities that ever become public are the CLEARING TICK and the AGGREGATE
///         RESIDUAL — the one net trade the batch could not fill internally, which
///         settles in a single `exchange_received` call against the real Curve pool.
///
///         Privacy pattern: (B) BATCH. Individual intents are hidden inside an
///         aggregate; the aggregate itself is public by necessity, because a public
///         AMM has to see what it is being asked to trade. Claiming a single trade is
///         invisible to a public pool would be a lie.
///
/// @dev The mechanism, its invariants and every expected number in the tests are
///      specified and proven in `reference/lebur-reference.mjs`, which runs on plain
///      `node`. Read that first — it is the same algorithm with the encryption
///      stripped out, and it is where the conservation and limit-respect bounds are
///      actually checked over ~13,000 batch shapes.
///
/// @dev Nox constraints that shape every line below (all hard-won, see the pitfall
///      list in the project brief):
///      - No `if` on encrypted data. `Nox.select` only, and BOTH branches always run.
///        There is no short-circuit, so every loop costs its worst case.
///      - No bitwise ops, no min/max, no mod, and no `select` over `ebool` — which is
///        why the argmax tie-break is done by packing two values into one euint256
///        instead of writing `a || (b && c)`.
///      - Nothing reverts on an encrypted condition, because a revert would leak the
///        secret through the transaction status.
///      - `div` by zero SATURATES TO MAX instead of reverting.
///      - Every stored encrypted result needs `Nox.allowThis` or the handle is dead
///        in the next transaction, permanently.
contract LeburBatch is ReentrancyGuard {
    // ── sizing ────────────────────────────────────────────────────────────────
    /// @dev Both caps bound gas AND the encrypted-op count, which on Nox is
    ///      wall-clock: the Runner is single-threaded with no batching, so a clear()
    ///      of T*(6N+17)+11 ops runs that many sequential pipeline round trips. The
    ///      live-demo envelope is T=4/N=3 comfortable, T=8/N=5 borderline.
    ///      Upgrade path if a real deployment needs more: paginate clear() over ticks
    ///      and carry the argmax across transactions.
    uint256 internal constant MAX_TICKS = 8;
    uint256 internal constant MAX_ORDERS = 8;

    /// @dev Per-order size clamp, applied under encryption (you cannot `require` on a
    ///      secret). Not a policy choice — it is what makes the argmax score packing
    ///      and the pro-rata multiplication provably overflow-free.
    ///      MAX_ORDERS * MAX_ORDER = 8e24 < 2^90, so D1+S1 always fits the low half.
    uint256 internal constant MAX_ORDER = 1e24; // 1,000,000 tokens at 18dp

    /// @dev Both sides of the book are paid out by independent floor divisions, out of
    ///      the same pot: the coin0 the askers receive is the very coin0 the bidders
    ///      spend. Each per-order floor loses under a wei, but on OPPOSITE sides of
    ///      the ledger — so the total paid can exceed the total collected by up to
    ///      #orders wei. ERC-7984 would absorb that by silently CAPPING whoever
    ///      claimed last rather than reverting. Shaving each output numerator by
    ///      MAX_ORDERS wei up front makes that impossible.
    uint256 internal constant DUST_SHAVE = MAX_ORDERS;

    uint256 internal constant WAD = 1e18;
    /// @dev Argmax packing: score = V * SHIFT + (IMB_MAX - (D1 + S1)). One `gt` then
    ///      means "more volume wins; on equal volume, less imbalance wins". Since
    ///      D1 + S1 == 2V + |D1 - S1|, minimising D1+S1 at fixed V minimises the
    ///      imbalance — one add instead of two safeSubs.
    uint256 internal constant SHIFT = 1 << 90;
    uint256 internal constant IMB_MAX = (1 << 90) - 1;

    /// @dev What the trader packs into one euint16 so an order costs TWO gateway
    ///      encryptions instead of three (the gateway round trip is ~2.3s measured):
    ///      code = side * MAX_TICKS + limitTick, side 1 = bid, anything else = ask.
    uint256 internal constant SIDE_STRIDE = MAX_TICKS;
    uint64 internal constant MIN_WINDOW = 5 minutes;
    uint64 internal constant MAX_WINDOW = 30 days;

    enum Phase { Open, Cleared, Settled }

    /// @dev The argmax carries, held in one memory struct rather than six locals.
    ///      `clear()` runs out of addressable stack slots otherwise, and this is a
    ///      smaller change than turning on viaIR — which would also mean shipping
    ///      bytecode from a different pipeline than the one already validated live.
    struct Best {
        euint256 score; // packed (volume, -imbalance)
        euint256 v;
        euint256 p;
        euint16 tick;
        euint256 dq;
        euint256 s1;
    }

    struct Order {
        address trader;
        euint256 qBuy;     // coin0 that actually arrived (0 for an ask)
        euint256 qSell;    // coin1 that actually arrived (0 for a bid)
        euint16 limitTick; // max tick for a bid, min tick for an ask
        bool paid;
    }

    // ── immutable wiring ──────────────────────────────────────────────────────
    IERC20 public immutable token0;                 // plaintext coin0 (pool index i0)
    IERC20 public immutable token1;                 // plaintext coin1 (pool index i1)
    IERC20ToERC7984Wrapper public immutable cToken0; // confidential coin0
    IERC20ToERC7984Wrapper public immutable cToken1; // confidential coin1
    ICurvePool public immutable pool;                // real, unmodified Curve pool
    int128 public immutable i0;                      // token0's index in the pool
    int128 public immutable i1;                      // token1's index in the pool
    // Not immutable: a settled batch can be reset for a new epoch (startNewBatch),
    // so one deployment serves many auctions instead of one.
    uint64 public submitDeadline;
    /// Which auction this is. Bumped by startNewBatch so an indexer or a frontend
    /// can tell an old batch's revealed values from the current one's.
    uint256 public epoch;
    /// How many orders of the CURRENT batch have been paid. A batch may only be
    /// reset once this reaches orders.length — otherwise clearing the order array
    /// would strand the escrow of anyone not yet paid, with no way to recover it.
    uint256 public paidCount;

    /// @notice The PUBLIC price ladder, coin0 per coin1, WAD-scaled, strictly
    ///         increasing. Public on purpose: the ladder is the auction's grammar,
    ///         and price discovery is the output a uniform-price auction is for. What
    ///         is secret is where on the ladder each order sits, and how big it is.
    uint256[] public ladder;

    Phase public phase;
    Order[] public orders;

    // ── clearing results, all encrypted ───────────────────────────────────────
    euint256 public bestV;    // coin1 crossed internally at the clearing price
    euint256 public bestP;    // clearing price
    euint16 public bestTick;  // clearing tick — the ONLY handle marked publicly decryptable here
    euint256 public bestDq;   // eligible bidder coin0 at the clearing tick
    euint256 public bestS1;   // eligible asker coin1 at the clearing tick
    euint256 public clearC0;  // coin0 the askers are owed at the clearing price
    euint256 public resid0;   // coin0 residual (0 unless demand was heavy)
    euint256 public resid1;   // coin1 residual (0 unless supply was heavy)
    /// @dev Wrapper unwrap-request ids. `unwrap()` marks the burn handle publicly
    ///      decryptable and `finalizeUnwrap()` verifies the gateway signature before
    ///      releasing the underlying — so the wrapper's own flow IS Lebur's residual
    ///      reveal. No separate decrypt-and-trust step, and nothing to get wrong.
    euint256 public unwrapId0;
    euint256 public unwrapId1;

    // ── settlement results, plaintext by design ───────────────────────────────
    uint256 public clearingTickRevealed;
    uint256 public clearingPrice;
    uint256 public residual0Revealed;
    uint256 public residual1Revealed;
    uint256 public poolOut;   // dy or dx, whichever direction ran
    bool public poolUsed;

    // ── payout aggregates, encrypted, fixed once at settle ────────────────────
    euint256 internal outB;   // coin1 shared out among eligible bidders
    euint256 internal usedB;  // coin0 those bidders spend
    euint256 internal outS;   // coin0 shared out among eligible askers
    euint256 internal usedS;  // coin1 those askers deliver
    euint256 internal denB;   // bestDq, guarded against zero
    euint256 internal denS;   // bestS1, guarded against zero

    // ── encrypted constants ───────────────────────────────────────────────────
    euint256 internal EZERO;
    euint256 internal EONE;
    euint256 internal EWAD;
    euint256 internal ECAP;
    euint256 internal ESHIFT;
    euint256 internal EIMBMAX;
    euint256 internal EDUST;
    euint16 internal ESTRIDE;
    euint16 internal ETICKMAX;
    euint16 internal EONE16;
    euint16[MAX_TICKS] internal ETICK;
    euint256[MAX_TICKS] internal EPRICE;

    event OrderSubmitted(uint256 indexed id, address indexed trader);
    event Cleared();
    event Settled(uint256 clearingTick, uint256 residual0, uint256 residual1, uint256 poolOut, bool poolUsed);
    event PaidOut(uint256 indexed id, address indexed trader);
    event BatchStarted(uint256 indexed epoch, uint64 submitDeadline);

    error WrongPhase();
    error DeadlinePassed();
    error DeadlineNotReached();
    error BookFull();
    error BadLadder();
    error BadDecryption();
    error UnknownOrder();

    constructor(
        IERC20 token0_,
        IERC20 token1_,
        IERC20ToERC7984Wrapper cToken0_,
        IERC20ToERC7984Wrapper cToken1_,
        ICurvePool pool_,
        int128 i0_,
        int128 i1_,
        uint256[] memory ladder_,
        uint64 submitDeadline_
    ) {
        if (ladder_.length == 0 || ladder_.length > MAX_TICKS) revert BadLadder();
        for (uint256 t; t < ladder_.length; ++t) {
            // A zero price would make the D1 division saturate to MAX instead of
            // reverting, and a non-monotone ladder would break the argmax's premise
            // that demand falls and supply rises. Both are checked once, in plaintext.
            if (ladder_[t] == 0) revert BadLadder();
            if (t > 0 && ladder_[t] <= ladder_[t - 1]) revert BadLadder();
            ladder.push(ladder_[t]);
        }

        token0 = token0_;
        token1 = token1_;
        cToken0 = cToken0_;
        cToken1 = cToken1_;
        pool = pool_;
        i0 = i0_;
        i1 = i1_;
        submitDeadline = submitDeadline_;

        // Public constants, so `toEuint256` (plaintext in calldata) is correct here —
        // it is only wrong for secrets, which must come through the gateway instead.
        EZERO = Nox.toEuint256(0);
        EONE = Nox.toEuint256(1);
        EWAD = Nox.toEuint256(WAD);
        ECAP = Nox.toEuint256(MAX_ORDER);
        ESHIFT = Nox.toEuint256(SHIFT);
        EIMBMAX = Nox.toEuint256(IMB_MAX);
        EDUST = Nox.toEuint256(DUST_SHAVE);
        ESTRIDE = Nox.toEuint16(uint16(SIDE_STRIDE));
        ETICKMAX = Nox.toEuint16(uint16(ladder_.length - 1));
        EONE16 = Nox.toEuint16(1);
        Nox.allowThis(EZERO);
        Nox.allowThis(EONE);
        Nox.allowThis(EWAD);
        Nox.allowThis(ECAP);
        Nox.allowThis(ESHIFT);
        Nox.allowThis(EIMBMAX);
        Nox.allowThis(EDUST);
        Nox.allowThis(ESTRIDE);
        Nox.allowThis(ETICKMAX);
        Nox.allowThis(EONE16);
        for (uint256 t; t < ladder_.length; ++t) {
            ETICK[t] = Nox.toEuint16(uint16(t));
            EPRICE[t] = Nox.toEuint256(ladder_[t]);
            Nox.allowThis(ETICK[t]);
            Nox.allowThis(EPRICE[t]);
        }

        // Give this contract an INITIALISED confidential balance in both coins, by
        // wrapping zero of each. Not decoration: ERC-7984 `require`s that the sender's
        // balance handle be initialised before any transfer or burn, so without this a
        // batch whose book happens to be all asks would have no cToken0 balance at all
        // and `clear()` would revert on the coin0 unwrap — a batch shape that is
        // perfectly legal and that no amount of encrypted-math care would survive.
        // The mint path has no such requirement, and a zero wrap needs no allowance.
        cToken0_.wrap(address(this), 0);
        cToken1_.wrap(address(this), 0);
    }

    // ── submit ────────────────────────────────────────────────────────────────

    /// @notice Place one sealed order. The trader must first `setOperator(this)` on
    ///         BOTH confidential tokens, because the contract pulls from both without
    ///         knowing which side the order is on — one of the two pulls moves zero.
    ///
    /// @param encAmount  order size: coin0 for a bid, coin1 for an ask.
    /// @param encCode    packed `side * 8 + limitTick`, side 1 = bid, else ask.
    /// @param viewer     address allowed to decrypt this order's recorded escrow —
    ///                   normally the trader's own wallet, or 0 to skip. Lets a trader
    ///                   verify what the contract booked without revealing it to
    ///                   anyone else. It cannot be revoked, so pass 0 if unsure.
    ///
    /// @dev The proofs bind (wallet, contract) and the wallet must be the DIRECT
    ///      `msg.sender` — routing this through a router or a multicall gives
    ///      `InvalidProof`.
    ///
    /// @dev The order's side is never needed as an encrypted branch downstream,
    ///      because it is materialised here as WHICH TOKEN MOVED. That is also why
    ///      the recorded sizes are the RETURNED `transferred` handles and not the
    ///      requested amount: an ERC-7984 transfer caps at the balance instead of
    ///      reverting, so a trader can never bid weight they did not escrow.
    function submitOrder(
        externalEuint256 encAmount,
        bytes calldata amountProof,
        externalEuint16 encCode,
        bytes calldata codeProof,
        address viewer
    ) external returns (uint256 id) {
        if (phase != Phase.Open) revert WrongPhase();
        if (block.timestamp > submitDeadline) revert DeadlinePassed();
        if (orders.length >= MAX_ORDERS) revert BookFull();

        euint256 amount = Nox.fromExternal(encAmount, amountProof);
        euint16 code = Nox.fromExternal(encCode, codeProof);

        // Clamp to MAX_ORDER before the transfer, not after, so escrow and booked
        // size stay equal — clamping after would strand the excess in the contract.
        amount = Nox.select(Nox.le(amount, ECAP), amount, ECAP);

        // Unpack the code. No mod in Nox, so: side = code / 8, tick = code - side*8.
        euint16 side = Nox.div(code, ESTRIDE);
        euint16 tick = Nox.sub(code, Nox.mul(side, ESTRIDE));
        // A trader who submits a code outside [0, 2*T) still gets a well-defined
        // order rather than a corrupt one: any side other than 1 reads as an ask, and
        // the tick is clamped into the ladder. We cannot revert on a secret.
        tick = Nox.select(Nox.le(tick, ETICKMAX), tick, ETICKMAX);
        ebool isBid = Nox.eq(side, EONE16);

        euint256 want0 = Nox.select(isBid, amount, EZERO);
        euint256 want1 = Nox.select(isBid, EZERO, amount);

        // Both pulls always happen; exactly one moves a non-zero amount. Doing only
        // the "right" one would require branching on a secret, and the very fact of
        // which token moved would leak the side.
        euint256 qBuy = _pull(cToken0, want0);
        euint256 qSell = _pull(cToken1, want1);

        id = orders.length;
        Order storage o = orders.push();
        o.trader = msg.sender;
        o.qBuy = qBuy;
        o.qSell = qSell;
        o.limitTick = tick;
        // MANDATORY on every stored handle. Skipping any one of these three kills it
        // permanently in the next transaction — the single most common Nox bug.
        Nox.allowThis(qBuy);
        Nox.allowThis(qSell);
        Nox.allowThis(tick);
        if (viewer != address(0)) {
            Nox.addViewer(qBuy, viewer);
            Nox.addViewer(qSell, viewer);
            Nox.addViewer(tick, viewer);
        }
        emit OrderSubmitted(id, msg.sender);
    }

    /// @dev Pull `want` of one confidential coin from the trader, tolerating a trader
    ///      who has never held that coin at all.
    ///
    ///      ERC-7984 `require`s the sender's balance handle to be initialised before
    ///      any transfer — so an asker who has never touched cUSDA cannot even be
    ///      asked for ZERO of it without the whole submission reverting. Skipping the
    ///      pull is safe to branch on in PLAINTEXT: whether an address has ever held a
    ///      token is already public from `confidentialBalanceOf`, so an observer who
    ///      could infer the order's side from that could have inferred it without us.
    ///
    ///      For real confidentiality a trader should hold BOTH coins before bidding,
    ///      which is why the demo scripts wrap a dust amount of the unused side. That
    ///      is a property of the trader's own history, not something this contract can
    ///      fix, and it is documented in the README rather than hidden.
    function _pull(IERC20ToERC7984Wrapper t, euint256 want) private returns (euint256) {
        if (!Nox.isInitialized(t.confidentialBalanceOf(msg.sender))) {
            // Handle migration: same value, virgin ACL. Returning the shared EZERO
            // constant instead would accumulate per-trader viewer grants on it.
            return Nox.add(EZERO, EZERO);
        }
        Nox.allowTransient(want, address(t));
        return t.confidentialTransferFrom(msg.sender, address(this), want);
    }

    // ── clear (encrypted) ─────────────────────────────────────────────────────

    /// @notice Scan the whole ladder under encryption, pick the clearing tick, and
    ///         compute the residual. Permissionless once the submit window closes.
    ///
    /// @dev PERMISSIONLESS BY DESIGN, like every step after it. From here on the
    ///      outcome is fully determined by the sealed book and the deadline; there is
    ///      no operator discretion left to exercise, and gating it on an operator
    ///      would let a silent one strand every trader's escrow in this contract
    ///      forever. Any trader can push a batch to completion; the caller just pays
    ///      the gas.
    ///
    /// @dev Cost: T * (6N + 17) + 11 encrypted ops. Nothing here can short-circuit —
    ///      the winning tick is a secret, so every tick is always fully evaluated.
    function clear() external {
        if (phase != Phase.Open) revert WrongPhase();
        if (block.timestamp <= submitDeadline) revert DeadlineNotReached();

        uint256 T = ladder.length;
        uint256 n = orders.length;

        Best memory b = Best({
            score: EZERO,
            v: EZERO,
            p: EPRICE[0], // never zero, so the divisions below are always safe
            tick: ETICK[0],
            dq: EZERO,
            s1: EZERO
        });

        for (uint256 t; t < T; ++t) {
            euint256 dq = EZERO;
            euint256 s1 = EZERO;
            for (uint256 i; i < n; ++i) {
                Order storage o = orders[i];
                // A bid is eligible at or below its limit; an ask at or above.
                dq = Nox.add(dq, Nox.select(Nox.ge(o.limitTick, ETICK[t]), o.qBuy, EZERO));
                s1 = Nox.add(s1, Nox.select(Nox.le(o.limitTick, ETICK[t]), o.qSell, EZERO));
            }
            // coin1 demanded. EPRICE[t] is a plaintext ladder constant checked non-zero
            // in the constructor, so this division can never hit the saturation trap.
            // mul first: dq <= 8e24, so dq*WAD <= 8e42, nowhere near 2^256.
            euint256 d1 = Nox.div(Nox.mul(dq, EWAD), EPRICE[t]);
            euint256 v = Nox.select(Nox.le(d1, s1), d1, s1); // min(), which Nox lacks
            (, euint256 low) = Nox.safeSub(EIMBMAX, Nox.add(d1, s1));
            euint256 score = Nox.add(Nox.mul(v, ESHIFT), low);
            // A tick where NOTHING crosses scores exactly zero and can never win.
            // Without this the low half alone would decide, and a book of bids with no
            // ask at all would "clear" at an arbitrary tick and route its whole size
            // to the pool. With no crossing there is no price discovery, so there is
            // no defensible price to bound that trade by.
            score = Nox.select(Nox.gt(v, EZERO), score, EZERO);

            // `gt`, not `ge`, so a fully tied tick leaves the earlier one standing.
            ebool better = Nox.gt(score, b.score);
            b.score = Nox.select(better, score, b.score);
            b.v = Nox.select(better, v, b.v);
            b.p = Nox.select(better, EPRICE[t], b.p);
            b.tick = Nox.select(better, ETICK[t], b.tick);
            b.dq = Nox.select(better, dq, b.dq);
            b.s1 = Nox.select(better, s1, b.s1);
        }

        // Recomputed once rather than carried through the loop — saves T selects.
        // b.p is only ever one of the ladder constants, so it is never zero.
        euint256 d1Best = Nox.div(Nox.mul(b.dq, EWAD), b.p);
        euint256 c0 = Nox.div(Nox.mul(b.v, b.p), EWAD);

        ebool buysHeavy = Nox.gt(d1Best, b.s1);
        (, euint256 excess0) = Nox.safeSub(b.dq, c0);
        (, euint256 excess1) = Nox.safeSub(b.s1, b.v);
        // Both residuals are computed and both are revealed. `buysHeavy` is
        // encrypted, so there is no branch to take — and revealing both leaks nothing
        // extra, since publishing a residual publishes its side by construction.
        euint256 r0 = Nox.select(buysHeavy, excess0, EZERO);
        euint256 r1 = Nox.select(buysHeavy, EZERO, excess1);

        bestV = b.v;
        bestP = b.p;
        bestTick = b.tick;
        bestDq = b.dq;
        bestS1 = b.s1;
        clearC0 = c0;
        resid0 = r0;
        resid1 = r1;
        Nox.allowThis(bestV);
        Nox.allowThis(bestP);
        Nox.allowThis(bestTick);
        Nox.allowThis(bestDq);
        Nox.allowThis(bestS1);
        Nox.allowThis(clearC0);
        Nox.allowThis(resid0);
        Nox.allowThis(resid1);

        // The clearing tick becomes public. This is the auction's PRODUCT, not a leak:
        // a uniform-price auction exists to discover one price and publish it.
        // Irreversible, which is fine — it is meant to be public forever.
        Nox.allowPublicDecryption(bestTick);

        // Request the unwrap of both residuals. This is what makes them public and
        // simultaneously turns them into plain ERC-20 the pool can see. The token
        // needs transient rights over the handle to burn against it.
        Nox.allowTransient(resid0, address(cToken0));
        unwrapId0 = cToken0.unwrap(address(this), address(this), resid0);
        Nox.allowTransient(resid1, address(cToken1));
        unwrapId1 = cToken1.unwrap(address(this), address(this), resid1);
        // Deliberately NOT allowThis on the unwrap ids: `unwrap` already made them
        // publicly decryptable, which is permanent and is all `finalizeUnwrap` needs,
        // and we never use them as a compute input.

        phase = Phase.Cleared;
        emit Cleared();
    }

    // ── settle (plaintext: reveal the residual, one Curve swap) ───────────────

    /// @notice Reveal the clearing tick and the residual, then settle the residual on
    ///         Curve in one `exchange_received`. Permissionless — every proof comes
    ///         from the gateway and is verified on-chain, so the caller cannot lie
    ///         about a single number.
    ///
    /// @param tick    claimed clearing tick, checked against the gateway signature.
    /// @param tickProof  gateway decryption proof for `bestTick`.
    /// @param proof0  gateway decryption proof for the coin0 unwrap request.
    /// @param proof1  gateway decryption proof for the coin1 unwrap request.
    ///
    /// @dev `_min_dy` is pinned at the CLEARING PRICE, not at a slippage tolerance.
    ///      That is what makes the blended price an eligible order realises no worse
    ///      than the tick its limit qualified at. If the pool cannot meet it the leg
    ///      is skipped, the residual is re-wrapped, and the auction degrades to a
    ///      plain pro-rata call auction — smaller fills, bigger refunds, limits still
    ///      honoured. The `get_dy` pre-check exists so that a pool which cannot meet
    ///      the bound leaves us on the skip path instead of reverting the whole batch
    ///      with the residual already unwrapped.
    function settle(
        uint16 tick,
        bytes calldata tickProof,
        bytes calldata proof0,
        bytes calldata proof1
    ) external nonReentrant {
        if (phase != Phase.Cleared) revert WrongPhase();
        if (Nox.publicDecrypt(bestTick, tickProof) != tick) revert BadDecryption();
        if (tick >= ladder.length) revert BadDecryption();
        clearingTickRevealed = tick;
        clearingPrice = ladder[tick];
        phase = Phase.Settled; // effects before interactions; nonReentrant also guards

        // Releasing the underlying IS the reveal: finalizeUnwrap verifies the gateway
        // signature over the burn handle before it transfers anything.
        cToken0.finalizeUnwrap(unwrapId0, proof0);
        cToken1.finalizeUnwrap(unwrapId1, proof1);
        // The contract holds no other plaintext balance of either coin between
        // batches, so its balance IS the revealed residual. Reading it back beats
        // trusting a number in the calldata, and beats decrypting the same handle twice.
        residual0Revealed = token0.balanceOf(address(this));
        residual1Revealed = token1.balanceOf(address(this));

        _swapResidual();
        _rewrap();
        _fixAggregates();

        emit Settled(tick, residual0Revealed, residual1Revealed, poolOut, poolUsed);
    }

    /// @dev The one public trade the whole batch produces.
    function _swapResidual() private {
        uint256 r0 = residual0Revealed;
        uint256 r1 = residual1Revealed;
        if (r0 > 0) {
            uint256 minDy = (r0 * WAD) / clearingPrice;
            if (pool.get_dy(i0, i1, r0) >= minDy) {
                // exchange_received swaps on the pool's own balance delta, so a plain
                // transfer is the whole handoff: no approval, no allowance, and the
                // pool never holds a standing permission over this contract's escrow.
                require(token0.transfer(address(pool), r0), "transfer failed");
                poolOut = pool.exchange_received(i0, i1, r0, minDy, address(this));
                poolUsed = true;
            }
        } else if (r1 > 0) {
            uint256 minDx = (r1 * clearingPrice) / WAD;
            if (pool.get_dy(i1, i0, r1) >= minDx) {
                require(token1.transfer(address(pool), r1), "transfer failed");
                poolOut = pool.exchange_received(i1, i0, r1, minDx, address(this));
                poolUsed = true;
            }
        }
    }

    /// @dev Everything plaintext still held goes back into the confidential side: the
    ///      pool's output if the leg ran, the untouched residual if it did not. One
    ///      block covers both, because the balances already say which happened.
    ///      Wrapping puts the amount in calldata, but these amounts are public anyway.
    function _rewrap() private {
        uint256 bal0 = token0.balanceOf(address(this));
        if (bal0 > 0) {
            require(token0.approve(address(cToken0), bal0), "approve failed");
            cToken0.wrap(address(this), bal0);
        }
        uint256 bal1 = token1.balanceOf(address(this));
        if (bal1 > 0) {
            require(token1.approve(address(cToken1), bal1), "approve failed");
            cToken1.wrap(address(this), bal1);
        }
    }

    /// @dev Fix the payout aggregates once, so every `payout(i)` divides the same pot.
    function _fixAggregates() private {
        bool buysWereHeavy = residual0Revealed > 0;
        uint256 dy = poolUsed && buysWereHeavy ? poolOut : 0;
        uint256 dx = poolUsed && !buysWereHeavy ? poolOut : 0;
        uint256 in0 = poolUsed && buysWereHeavy ? residual0Revealed : 0;
        uint256 in1 = poolUsed && !buysWereHeavy ? residual1Revealed : 0;

        // Outputs are shaved by DUST_SHAVE; inputs are not. A bidder must still spend
        // exactly its pro-rata share of what the batch actually consumed.
        (, outB) = Nox.safeSub(Nox.add(bestV, Nox.toEuint256(dy)), EDUST);
        usedB = Nox.add(clearC0, Nox.toEuint256(in0));
        (, outS) = Nox.safeSub(Nox.add(clearC0, Nox.toEuint256(dx)), EDUST);
        usedS = Nox.add(bestV, Nox.toEuint256(in1));
        // Zero-divisor guards. A batch with no eligible bidders leaves bestDq at zero,
        // and `div` would then saturate to 2^256-1 in perfect silence rather than
        // revert. The numerators are zero in that case anyway, but 0/0 saturates too.
        denB = Nox.select(Nox.eq(bestDq, EZERO), EONE, bestDq);
        denS = Nox.select(Nox.eq(bestS1, EZERO), EONE, bestS1);
        Nox.allowThis(outB);
        Nox.allowThis(usedB);
        Nox.allowThis(outS);
        Nox.allowThis(usedS);
        Nox.allowThis(denB);
        Nox.allowThis(denS);
    }

    /// @notice Reset a fully-paid batch so this deployment can run another auction.
    /// @dev Permissionless, like every other step here — there is no operator to
    ///      gate it on, and gating it would reintroduce the single party this
    ///      design deliberately does without.
    ///
    ///      The paidCount check is the safety property: clearing `orders` while any
    ///      order is unpaid would destroy the only record of that trader's escrow.
    ///      The encrypted aggregates are not cleared because `clear()` overwrites
    ///      every one of them, and the phase guards make them unreadable meanwhile;
    ///      the REVEALED plaintext mirrors are cleared, because those are public and
    ///      a stale one would misreport the new batch.
    function startNewBatch(uint64 newDeadline) external {
        if (phase != Phase.Settled) revert WrongPhase();
        require(paidCount == orders.length, "unpaid orders remain");
        // Bounded so a caller can neither open a window that closes instantly nor
        // one that parks the deployment for years.
        require(
            newDeadline >= block.timestamp + MIN_WINDOW && newDeadline <= block.timestamp + MAX_WINDOW,
            "deadline out of range"
        );

        delete orders;
        paidCount = 0;
        clearingTickRevealed = 0;
        clearingPrice = 0;
        residual0Revealed = 0;
        residual1Revealed = 0;
        poolOut = 0;
        poolUsed = false;
        submitDeadline = newDeadline;
        phase = Phase.Open;
        emit BatchStarted(++epoch, newDeadline);
    }

    // ── payout (encrypted) ────────────────────────────────────────────────────

    /// @notice Pay one order its pro-rata fill plus whatever escrow it did not spend,
    ///         both still confidential. Permissionless and idempotent; anyone can push
    ///         any order's payout, and the recipient is fixed at submit time.
    ///
    /// @dev No encrypted branch on the order's side: qBuy and qSell are already
    ///      masked, so the wrong-side term multiplies by zero. Both terms always
    ///      evaluate, which is exactly what a `select` would have cost.
    ///
    /// @dev DUST. Four floor divisions per order, plus the DUST_SHAVE, leave a few tens
    ///      of wei per asset per batch stranded here. That is deliberate and it stays:
    ///      a positive rounding buffer is what guarantees the LAST payout of a batch is
    ///      never the one ERC-7984 silently caps a wei short. There is no sweep
    ///      function, because a sweep is a lever an operator could pull mid-batch.
    function payout(uint256 id) external nonReentrant {
        if (phase != Phase.Settled) revert WrongPhase();
        if (id >= orders.length) revert UnknownOrder();
        Order storage o = orders[id];
        if (o.paid) return;
        o.paid = true;
        ++paidCount;

        euint256 qEb = Nox.select(Nox.ge(o.limitTick, bestTick), o.qBuy, EZERO);
        euint256 qEs = Nox.select(Nox.le(o.limitTick, bestTick), o.qSell, EZERO);

        euint256 gotCoin1 = Nox.div(Nox.mul(qEb, outB), denB);
        euint256 spentCoin0 = Nox.div(Nox.mul(qEb, usedB), denB);
        euint256 gotCoin0 = Nox.div(Nox.mul(qEs, outS), denS);
        euint256 spentCoin1 = Nox.div(Nox.mul(qEs, usedS), denS);

        (, euint256 refund0) = Nox.safeSub(o.qBuy, spentCoin0);
        (, euint256 refund1) = Nox.safeSub(o.qSell, spentCoin1);
        euint256 pay0 = Nox.add(gotCoin0, refund0);
        euint256 pay1 = Nox.add(gotCoin1, refund1);

        // The recipient becomes a permanent admin on their own new balance handle
        // inside ERC7984Base, so they can decrypt what they hold without any grant
        // from us — and we never take a viewer role over their fill.
        Nox.allowTransient(pay0, address(cToken0));
        cToken0.confidentialTransfer(o.trader, pay0);
        Nox.allowTransient(pay1, address(cToken1));
        cToken1.confidentialTransfer(o.trader, pay1);

        emit PaidOut(id, o.trader);
    }

    // ── views ─────────────────────────────────────────────────────────────────

    function orderCount() external view returns (uint256) {
        return orders.length;
    }

    function tickCount() external view returns (uint256) {
        return ladder.length;
    }

    /// @notice Gross notional the batch would have pushed through the public pool if
    ///         every order had routed itself, against what actually reaches it. This
    ///         is only callable after settle, and only reads already-public numbers.
    /// @dev The honest metric is PUBLIC FOOTPRINT, not slippage saved: Curve is flat
    ///      at the peg, so the residual settles at roughly par either way. The claim
    ///      is confidentiality and MEV resistance at institutional size, settling at
    ///      par — not "we saved you slippage".
    function publicFootprint() external view returns (uint256 routed) {
        if (phase != Phase.Settled) revert WrongPhase();
        return residual0Revealed + residual1Revealed;
    }
}
