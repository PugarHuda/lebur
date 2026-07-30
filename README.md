# Lebur — a confidential uniform-price batch auction on Curve

N sealed orders net against each other inside a TEE. Only the **clearing price** and
the **aggregate residual** ever become public, and the residual settles in a single
`exchange_received` call against an **unmodified** Curve StableSwap-NG pool on
Ethereum Sepolia.

Built on [iExec Nox](https://docs.noxprotocol.io) (Intel TDX) for the WTF Hackathon
Summer Edition.

**Status: live on Ethereum Sepolia**, on **this branch** — no revision gap between
the code here and the code running. A batch of two sealed orders cleared and
settled: 600 of the 1000 crossed inside the enclave and never touched the chain,
and the 399.7 residual settled through one `exchange_received` against a real
Curve pool. There is a **settled** batcher you can read and an **open** one you
can trade against until 2026-08-05 ([both](#two-live-batchers-both-running-this-branch)).
**The UI is live at [lebur.vercel.app](https://lebur.vercel.app)** — nothing to
install. **11 tests pass**
against the real Nox offchain stack — encrypted submit, encrypted ladder scan,
gateway public decrypt, Curve settlement, confidential payouts, with every trader's
final balance decrypted and checked against the reference oracle to the wei.
`reference/lebur-reference.mjs` checks ~13,000 batch shapes, and every deployed
contract is source-verified.

**Privacy pattern: (B) Batch.** N private intents net inside our contract; the
residual settles publicly. We are not claiming a single user's single trade is hidden
from a public AMM — a public pool has to see what it is being asked to trade. What is
hidden is *who wanted what, at what price, and how much of it.*

---

## What actually happens

```
                      ENCRYPTED                          PUBLIC
  ┌────────────────────────────────────────┐   ┌──────────────────────────┐
  │ submitOrder x N                        │   │                          │
  │   size, side, limit tick — all sealed  │   │                          │
  │                                        │   │                          │
  │ clear()                                │   │                          │
  │   scan the whole price ladder          │   │                          │
  │   argmax executed volume               │   │                          │
  │   pro-rata the heavy side              │   │                          │
  │                          ──── reveal ──┼──▶│ clearing tick            │
  │                                        │   │ aggregate residual       │
  │                                        │   │                          │
  │                                        │   │ ONE exchange_received    │
  │                          ◀── pool out ─┼───│ on real Curve            │
  │ payout(i) x N                          │   │                          │
  │   confidential ERC-7984 transfers      │   │                          │
  └────────────────────────────────────────┘   └──────────────────────────┘
```

Three numbers leave the enclave per batch. Everything else — every order's size, side,
limit and fill — stays encrypted forever.

## The mechanism

Price is quoted as coin0 per coin1 on a **public** ladder of `T` ticks. The ladder is
the auction's grammar and price discovery is its product, so both are public on
purpose. What is secret is where on the ladder each order sits, and how big it is.

* a **bidder** escrows coin0 and wants coin1 — eligible at ticks at or below its limit
* an **asker** escrows coin1 and wants coin0 — eligible at ticks at or above its limit

At every tick, under encryption:

```
Dq(t) = Σ eligible bidder coin0                     non-increasing in t
D1(t) = Dq(t) · 1e18 / P[t]     coin1 demanded      non-increasing in t
S1(t) = Σ eligible asker coin1  coin1 supplied      non-decreasing in t
V(t)  = min(D1, S1)             crossable volume
```

The clearing tick maximises `V`, and among equal `V` minimises the imbalance
`|D1 − S1|` — the rule real call auctions use. `V` crosses inside the contract at one
price. The heavy side's excess is the **residual**, the only trade the public chain
sees.

**`_min_dy` is pinned at the clearing price**, not at a slippage tolerance. That is
what makes the blended price an eligible order realises no worse than the tick its
limit qualified at. If the pool cannot meet that bound, the leg is **skipped**, the
residual is re-wrapped, and the auction degrades to a plain pro-rata call auction:
smaller fills, bigger refunds, limits still honoured. Taking a bad price because the
pool happened to be offering one is the failure this design refuses.

### Three things worth pointing at

**The argmax carry is unnecessary.** The received wisdom (and this project's own
initial estimate) is that each order's contribution must be carried *through* the
argmax reduction, costing `+N` ops per tick. It does not: `Nox.ge(limitTick, bestTick)`
compares two *encrypted* values perfectly well, so eligibility can be recomputed once
at payout against the encrypted winning tick. That removes `T·N` selects from the
budget — the single biggest saving in the design.

**The tie-break is packed, not branched.** Nox has no `select` over `ebool` and no
bitwise ops, so `moreVolume || (equalVolume && lessImbalance)` is not expressible. It
is instead packed into one `euint256` — `score = V·2⁹⁰ + (2⁹⁰−1 − (D1+S1))` — and
resolved by a single `gt`. `D1 + S1 == 2V + |D1 − S1|`, so minimising the sum at fixed
volume *is* minimising the imbalance, for one `add` instead of two `safeSub`s. The
`MAX_ORDER × MAX_ORDERS` clamp is what makes the packing provably overflow-free.

**The unwrap flow is the reveal.** `ERC20ToERC7984Wrapper.unwrap()` already marks the
burn handle publicly decryptable, and `finalizeUnwrap()` verifies the gateway signature
before releasing the underlying. So publishing the residual and turning it into a plain
ERC-20 the pool can see are *the same operation*. No separate decrypt-and-trust step.

## Layout

```
reference/lebur-reference.mjs      the specification. read this first
packages/snap/                     MetaMask Snap: in-sandbox VIEWING key (not encryption)
packages/web/                      Next.js trader UI
packages/contracts/
  contracts/LeburBatch.sol         the auction
  contracts/ConfidentialToken.sol  ERC-7984 wrapper over a plain ERC-20
  contracts/FaucetERC20.sol        the two coins
  contracts/ICurve.sol             the Curve surface we touch
  contracts/mocks/MockCurvePool.sol  test double — Curve is Sepolia-only
  test/batch.e2e.test.ts           asserts against the reference oracle
  test/guards.test.ts              nine guard tests: ladders, phases, paging, empty book
  scripts/verify-curve.ts          read-only proof of every Curve claim below
  scripts/curve-config.ts          the factory/blueprint addresses, in one place
  scripts/deploy-pool.ts           deploy_plain_pool — DRY RUN unless BROADCAST=1
  scripts/deploy-sepolia.ts        deploy the batcher
  scripts/submit-order.ts          one real sealed order via the live gateway
  scripts/run-batch.ts             clear -> reveal -> settle -> payouts
  verify-args.js                   constructor args for `verify blockscout`
feedback.md                        for the iExec team
```

## Run it

```bash
node reference/lebur-reference.mjs        # no deps, no toolchain, ~13k batches checked

cd packages/contracts
npm install
npx hardhat compile
npx hardhat test                          # needs Docker: boots the whole Nox stack

node --experimental-strip-types scripts/verify-curve.ts   # read-only, no gas
```

Then, against Sepolia (`cp ../../.env.example .env` first):

```bash
BROADCAST=1 npx hardhat run scripts/deploy-pool.ts --network sepolia
npx hardhat run scripts/deploy-sepolia.ts --network sepolia
SIDE=bid AMOUNT=1000 TICK=2 npx hardhat run scripts/submit-order.ts --network sepolia
npx hardhat run scripts/run-batch.ts --network sepolia
```

`deploy-pool.ts` **simulates and stops** unless you pass `BROADCAST=1`. Every script
awaits its receipts — viem's `write` does not, and that bug has already cost this
codebase one broken deployment.

## The reference oracle

`reference/lebur-reference.mjs` is the specification, not a comment. It mirrors the
Solidity op for op — same fixed loop bounds, same floor division, same `select`
semantics where both branches always run, same zero-guards — and the e2e test imports
it rather than hand-copying its expectations, because a duplicated expectation that
silently drifts is worse than no oracle at all.

It checks, over the demo book plus an exhaustive sweep of every one-bid/one-ask shape,
the full limit-tick cube for three-order books, and randomised books up to `N=8`
(~13,000 batches, each against six pool behaviours including both sides of the
`_min_dy` boundary):

- demand falls and supply rises across the ladder, so the argmax has a real peak
- the packed score picks exactly what max-volume/min-imbalance says it should
- **conservation** — the batch never distributes more than it collected
- **limit respect** — an eligible order is within **3 wei** of exact clearing-price
  settlement, *regardless of size*
- out-of-the-money orders are refunded **exactly** whole
- no `euint256` overflow anywhere, given the clamps
- dust stays in the low tens of wei

Three real bugs came out of writing it before the Solidity:

1. A naive "lowest tick wins" tie-break handed the entire excess-demand surplus to the
   bidders. Fixed by the imbalance rule.
2. With no crossing at all, the score degenerated into "minimise `D1+S1`", so a book of
   bids with **no ask** would pick an arbitrary tick and route its whole size to the
   pool. Fixed by scoring a non-crossing tick at exactly zero.
3. The two sides are paid by independent floor divisions out of the *same* pot, so the
   total paid could exceed the total collected by up to `#orders` wei — which ERC-7984
   absorbs by silently capping whoever claims last. Fixed by shaving `MAX_ORDERS` wei
   off each output numerator.

None of these would have reverted. All three would have quietly mispaid someone.

## Op budget

Nox is a **TEE, not FHE**: compute inside the enclave is cheap, but every op is a
pipeline round trip on a **single-threaded Runner with no batching**, so the op count
is wall-clock.

```
clear()    T · (6N + 17) + 11
payouts    10 + 16N
```

| T | N | clear | payouts | total |
|---|---|---|---|---|
| 4 | 3 | 151 | 58 | **209** |
| 4 | 5 | 199 | 90 | 289 |
| 8 | 5 | 387 | 90 | 477 |
| 8 | 8 | 531 | 138 | 669 |

Gas **measured** by `npx hardhat test` against the real Nox stack, `T=4 / N=3`:

| call | gas |
|---|---|
| `submitOrder` | ~825k–842k |
| `clear()` — 209 encrypted ops | **2,923,992** |
| `settle()` — 2× `finalizeUnwrap` + `exchange_received` | 913,939 |
| `payout(i)` | ~671k–688k each |
| whole batch | **~8.4M** |

That is **~14k gas per encrypted op**, which lines up with the independent calibration
point from this author's sibling project on live Sepolia: a 164-op encrypted integer
sqrt cost **2.05M gas** (~12.5k/op), with a gateway `encryptInput` round trip at
**~2.3s**. So `T=4/N=3` is comfortable for a live demo, `T=8/N=5` is borderline, and
anything larger gets pre-recorded.

`MAX_TICKS` and `MAX_ORDERS` are both 8 — but they are **policy numbers, not gas
numbers**, because `clearPaged(maxTicks)` scans the ladder across as many
transactions as it takes. See [Clearing does not have to fit one
transaction](#clearing-does-not-have-to-fit-one-transaction).

An order costs **two** gateway encryptions, not three: side and limit tick ride packed
as `side · 8 + tick` in one `euint16`, unpacked on-chain with `div`/`sub` because Nox
has no `mod`.

## Curve on Sepolia — verified, not documented

Curve's own docs never mention Sepolia (`/deployments/` 404s), which is why nobody
else found this. Everything below was confirmed by direct RPC, re-run by
`scripts/verify-curve.ts`:

| | |
|---|---|
| StableSwap-NG Factory | `0xfb37b8D939FFa77114005e61CFc2e543d6F49A81` — 178 pools |
| Pool blueprint | `0xE12374F193f91f71CE40D53E0db102eBaA9098D5` |
| Factory codehash | `0xb78c1b32cd364260f3fa497ccc7e98c73cdc26bdae2d3635e763ee8b59a1d6fd` — **byte-identical to mainnet** |
| `exchange_received` | selector `0xafb43012`, present in live pool bytecode |
| `deploy_plain_pool` | selector `0x5bcd3d83`, 11 arguments (two other plausible overloads confirmed **absent**) |

There is no Router NG and no AddressProvider on Sepolia, so Lebur talks to the pool
directly. That "unmodified" claim is checkable by a judge in one `eth_getCode`.

Selector presence is proved by **scanning the deployed runtime bytecode**, not by
guessing at revert strings: an `eth_call` to `exchange_received` reverts whether the
selector exists or not, and viem reports both cases identically. Vyper's dispatcher
embeds every method id as a `PUSH4` immediate, so the bytes are either there or not.

**We deploy our own pool.** Of the 178 live ones roughly half have `totalSupply == 0`,
their coins are bespoke tokens with no faucet, and none holds canonical Sepolia USDC.

## `exchange_received` is the right seam

It swaps on the pool's own balance delta, so the batcher transfers in and then swaps:
**no approval, no `transferFrom`.** One hop saved per batch, and the pool never holds a
standing spend permission over escrowed user funds.

## What is simulated, and what is not

One thing: **the two coins are faucet ERC-20s.** Sepolia offers no alternative, and a
faucet token behind a real factory-deployed pool is the standard testnet answer.

Nothing on the confidential path is simulated. The auction runs on live Nox, the escrow
is real ERC-7984, and the settlement leg is real Curve bytecode. `MockCurvePool.sol`
exists only because Curve is on Sepolia and not on a fresh EDR node — it is a test
double for an *external* protocol, and `LeburBatch` cannot tell the difference because
it only ever sees `ICurvePool`.

## Honest framing, and the limits

Curve's curve is flat near the peg, so the post-netting residual settles at roughly
1:1 — which also means **the slippage saving is small**. The claim is
**confidentiality and MEV resistance at institutional size, settling at par**, *not*
"we save you slippage". The metric that actually moves is **public footprint**: in the
demo book, 25% of gross notional reaches the pool and 75% crosses invisibly.

Known limits, stated rather than buried:

- **A donation to the contract is ignored, not counted.** Settlement measures the
  *delta* across `finalizeUnwrap`, not its own balance. It used to read the
  balance — obviously correct, since the contract holds no plaintext coin between
  batches, until you notice anyone can `transfer` either token straight to the
  address for the price of one ERC-20 call. That inflated the published residual
  and therefore `publicFootprint`, the single number this design offers as its
  privacy claim, and pushed a stranger's tokens through the Curve leg as if a
  trader had sold them. A donation now stays put and becomes confidential dust.
  The e2e test grifts the batch mid-settlement and every residual assertion is
  against the reference oracle, so a leak of even a wei fails it.
- **The residual's side is public**, by construction. Publishing "the batch was net
  long 400 coin0" tells you demand was heavy. That is inherent to settling on a public
  AMM, and it is why both residuals are computed and both revealed — skipping the zero
  one would leak nothing extra but would also gain nothing.
- **A trader who has never held both coins leaks their side.** The batcher pulls from
  both tokens without knowing which side an order is on, and ERC-7984 reverts on a
  transfer from an uninitialised balance handle — so `_pull` skips the pull for a coin
  the trader has never held. That branch is plaintext, and safe to be, because
  `confidentialBalanceOf` already makes the same fact public. Hold both coins. The
  scripts wrap a dust amount of the unused side for exactly this reason.
- **`wrap()` is public.** The amount is plaintext in calldata. The privacy boundary is
  the *order*, not the wrap: a trader wraps a round number ahead of time and then
  trades an arbitrary secret slice of it.
- **The contract is admin over every order handle** — it has to be, to compute on them.
  No operator EOA ever is, and the contract exposes no path that decrypts one. There is
  no privileged role in this system at all: `clear`, `settle` and `payout` are all
  permissionless, so a silent operator cannot strand anyone's escrow.
- **Dust stays.** A few tens of wei per asset per batch remain in the contract as a
  permanent rounding buffer. That is deliberate: a positive buffer is what guarantees
  the last payout of a batch is never the one ERC-7984 caps a wei short. There is no
  sweep function, because a sweep is a lever an operator could pull mid-batch.
- **One batch at a time.** A deployment runs many auctions in sequence via
  [`startNewBatch`](#one-deployment-many-auctions), but never two concurrently:
  there is a single order book, and a reset is refused until every order of the
  previous batch has been paid. Concurrent books would need the whole aggregate
  set indexed by epoch, which is not built.

## Prior art

Batch auctions as an MEV defence are not new — CoW Protocol settles them in the open,
and Penumbra and Renegade run sealed order flow in ZK. What is specific here is the
*mechanism inside the seal*: a real uniform-price call auction, with an encrypted
ladder scan, an argmax carrying a proper max-volume/min-imbalance tie-break, and
pro-rata fills — rather than a netting pass that reveals one aggregate. And the
residual settles against an unmodified production AMM, not a bespoke venue.

## Cost of going live, measured (not estimated)

The whole deploy sequence was rehearsed against a **forked Sepolia** (real Curve
factory, real NoxCompute state) under anvil, so these are executed gas numbers
rather than guesses:

| Step | Gas |
|---|---|
| FaucetERC20 × 2 | 1,065k |
| **`deploy_plain_pool`** (Curve StableSwap-NG) | **5,357k** |
| mint / approve / `add_liquidity` seeding | 481k |
| ConfidentialToken × 2 | 3,862k |
| **LeburBatch** | **3,642k** |
| trader setup (mint/approve/wrap/setOperator, both sides) | 703k |
| `clear()` calibration (n=0) | 1,589k |
| **total rehearsed** | **16,698k ≈ 0.0177 ETH @ 1.06 gwei** |

Add the real auction on top — `submitOrder` ~850k each, `clear()` at T=4/N=3
2.92M, `settle` 939k, `payout` ~680k each — and a live end-to-end run is
**~0.022–0.024 ETH**. The pool deploy alone is a third of it.

`get_dy(0,1,1e18) = 999899950253733814` on the freshly seeded pool, i.e. ~1:1 at
the peg, exactly as the flat-curve framing above predicts.

**No existing pool can be reused.** All 179 StableSwap-NG pools on Sepolia were
scanned for a pair of 18-decimal, open-`mint()` coins: zero matches. Only four
pre-existing open-mint 18dp tokens exist at all (bFRAX `0xf4E7644d…`, USDEToken
`0xe228BEC1…`, K1 `0x8BCb988f…`, DAI `0x2EF287cd…`) and no pool pairs any two of
them. Reusing those tokens still saves the 1,065k of faucet deploys, but the
pool must be our own — which is what the Curve research in this README predicted.

## Live on Ethereum Sepolia

Deployed and exercised 2026-07-27. Every address below is real, and the Curve
pool is the project's own, deployed through the **unmodified** upstream
StableSwap-NG factory:

| Contract | Address |
|---|---|
| lUSDA (faucet ERC-20) | `0x838204BC3D82B29E3697Bfe9A17662c57943e34F` |
| lUSDB (faucet ERC-20) | `0x8A00F10b198f8cC9266d6E330b9792E395707CB7` |
| **Curve StableSwap-NG pool** | `0x29f2087bc6489e9FC9f35CA34132Fca9158de7A0` |
| cUSDA (ERC-7984 wrapper) | `0x9332437d2abdcca57143b96d6d1fce1ad51e7c35` |
| cUSDB (ERC-7984 wrapper) | `0x37e9f9e43c929722cc61475db3eb053575e85efd` |
| **LeburBatch** | `0x04c5a38af74d9f40c444dcb90f5d66724998afbd` |
| StableSwap-NG factory (upstream, unmodified) | `0xfb37b8D939FFa77114005e61CFc2e543d6F49A81` |

Measured live gas: `deploy_plain_pool` **5,357,051** (the fork rehearsal
predicted 5,357,063 — accurate to 12 gas), `add_liquidity` 250,801,
ConfidentialToken 1,930,818 each, LeburBatch 3,642,265, `submitOrder`
**761,861** and **744,749**.

Pool seeded with 100,000 of each coin; `get_dy(0, 1, 1e18) = 999899950253733814`,
i.e. ~1:1 at the peg — the flat curve this design settles against.

### The live batch

Two sealed orders, sizes and limits encrypted end to end through the live Nox
gateway:

- **bid** 1000 lUSDA, limit tick 2 (1.0005)
- **ask** 600 lUSDB, limit tick 1 (1.0)

They cross 600 internally, which leaves a genuine residual for the public pool
rather than a fully-netted batch that would never touch Curve. Both orders come
from one address because the mechanism keys on orders, not identities — worth
stating plainly rather than implying two independent traders.

## Two live batchers, both running this branch

Re-run on 2026-07-29 against the same Curve pool and coins, on the contract as it
stands here. A settled batch is a read-only artefact, so there is also an open one
you can actually trade against.

### Settled — read the finished auction

[`0x6a022daa…`](https://eth-sepolia.blockscout.com/address/0x6a022daacef56e7751828b17a3da3486950008b2)
holds its result in readable state:

| | |
|---|---|
| clearing tick | **2** (price 1.0005) |
| residual to the public pool | **399.7 lUSDA** / 0 lUSDB |
| Curve leg | used — received **399.620286334689100000 lUSDB** |
| `publicFootprint` | **399.7** |
| paid / orders | 2 / 2 · no plaintext coin stranded |

Measured gas: `clear()` **2,147,944** · `settle()` 943,431 · `payout()` 594k/577k
· `submitOrder` 764k/747k.

### Open — go and trade against it

[`0x5f4a77e5…`](https://eth-sepolia.blockscout.com/address/0x5f4a77e5d14acb63f3d344dd186d1cd9c94c0ddd)
takes orders until **2026-08-05**, and it is what `packages/web/.env.local` points
at. Six sealed orders are already in the book, chosen to cover distinct
behaviours rather than to look busy: two that cross, two that are **out of the
money** on opposite sides and will be refunded whole, one placed from a headless
browser by the wallet-injected Playwright spec, and one at **1,000,000 — the
`MAX_ORDER` clamp boundary**, so the encrypted clamp in `submitOrder` has an
on-chain execution and not just a unit test. This one also settled a batch first, then **reopened itself** with
`startNewBatch` (119k gas, epoch 0 → 1) — so "one deployment, many auctions" is
not a claim in this README, it is the state that address is in.

That reset is also why its revealed values read zero: the plaintext mirrors are
deliberately cleared, because a stale clearing price would misreport an auction
that has not happened yet.

| Contract | Address |
|---|---|
| LeburBatch — settled | `0x6a022daacef56e7751828b17a3da3486950008b2` |
| LeburBatch — open until 2026-08-05 | `0x5f4a77e5d14acb63f3d344dd186d1cd9c94c0ddd` |
| cUSDA / cUSDB — settled batch | `0xd9953a0f…638b` / `0x649bca4a…8a1a` |
| cUSDA / cUSDB — open batch | `0xc8b97213…e067` / `0x106251f4…de2a` |
| Curve StableSwap-NG pool, shared | `0x29f2087bc6489e9FC9f35CA34132Fca9158de7A0` |
| lUSDA / lUSDB, shared | `0x838204BC…e34F` / `0x8A00F10b…7CB7` |

The [2026-07-27 batch](https://eth-sepolia.blockscout.com/address/0x04c5a38af74d9f40c444dcb90f5d66724998afbd)
produced the same result on an older revision of the contract.

## Frontend

`packages/web` — a Next.js trader UI for a live batch. The whole permissionless
lifecycle is a button, because a property nobody can exercise is a claim rather
than a feature:

- **Seal an order** end to end — mint → wrap → the dust wrap that keeps your side
  private → two gateway encryptions → `submitOrder`, with the viewing mode
  (Snap-held key or EOA fallback) stated rather than chosen silently.
- **Clear the batch** — once the window closes, anyone can run the encrypted
  ladder scan from the page.
- **Reveal and settle** — the three gateway-signed decryptions (clearing tick and
  both residuals) and the Curve leg, in one button. The contract verifies every
  signature itself, so whoever presses it supplies proofs rather than figures and
  cannot influence a single number.
- **Read your own order back** — gasless, gated by the viewer role granted at
  submit time, so it works for your orders and fails for everyone else's. The size
  sits on-chain the whole time; what makes it private is that only you can turn it
  into a number.
- **Collect the fills** — `payout` per order, also permissionless, also
  idempotent. The recipient was fixed when the order was sealed, so pushing
  someone else's payout can only ever pay them, and the fill and refund both move
  as confidential transfers.
- **Start the next auction** — `startNewBatch` on a settled deployment, refused
  by the contract until every order is paid. The page probes `epoch` first and
  says so plainly when the configured address predates the function, rather than
  offering a button that would revert.

It reports the clearing price, the residual that reached the public pool, and the
`publicFootprint` — the total value that ever became visible, against sealed
orders whose sizes never do. A settled batch says it is settled and explains what
you can still do with it; it does not leave a dead order form on screen.

**Live: [lebur.vercel.app](https://lebur.vercel.app)** — a landing page at `/`
with the settled batch's clearing price, public footprint and Curve fill read live
from chain, and the trader UI at `/app`. Nothing to install.

The UI shares a design system with the sibling project — same tokens, same type
scale, amber where Lirih is green, because this is an auction and that is funding.
Tabular figures on every number, 44px minimum targets, visible focus rings,
`prefers-reduced-motion` honoured, and inline SVG rather than emoji for icons.

`packages/web/.env.local` is committed, so a local run reaches the same live state:

```bash
cd packages/web && npm install && npm run dev
```

### The write path is tested in a browser too

`e2e/wallet.ts` injects a real signing wallet as `window.ethereum` — an EIP-1193
provider backed by an ethers `Wallet`, not a mock of MetaMask. Transactions are
signed, broadcast and mined on real Sepolia, so the opt-in spec drives the whole
sequence a user actually performs and asserts the result on-chain.

That is where this project's real bugs lived, and read-only assertions cannot
reach any of them. It is **opt-in** because it spends gas:

```bash
WALLET_KEY=0x… npm run test:e2e            # skips without the key
```

It deliberately does NOT pretend a Snap is installed: `wallet_requestSnaps`
throws, the page falls back to the EOA viewer, and the spec asserts that the page
*says so* — which is the check that would catch a page quietly downgrading while
still calling itself coercion-resistant. Loading the Snap in MetaMask Flask is
still a human's job, because MetaMask's own RPC restrictions are the thing that
put the viewing key in the Snap to begin with.

It is laid out as a dashboard: a sidebar switching between **Place an order / Advance the batch / My order / What leaks**, with the
contract's state pinned above the panels so it does not move when you do. The
panels are alternatives rather than steps, and in a single column the answer sat
below the question — you scrolled past what you came to read to reach what you
came to do. Below 900px the rail becomes a scrollable strip of tabs, because a
232px sidebar on a 375px screen leaves no room for the thing it navigates.

### The design claims are tested, not asserted

This README used to say the UI passes contrast, keeps focus rings, uses 44px
targets, honours `prefers-reduced-motion` and survives a phone. All of that was
written and none of it was checked, which is the same "claim stronger than the
evidence" pattern the rest of this project spent its life removing. So it gets
the same treatment: `quality.spec.ts` runs an axe scan over both pages, measures
every control that spends gas, tabs into the page and reads back the computed
outline, emulates reduced motion, and loads at 375px asserting the document does
not scroll sideways.

It found three real defects on the first run, all invisible on a desktop:
`--fg-dim` measured ~3.6:1 against the card surface where 4.5:1 was claimed; a
project/side `<select>` sized itself to its longest option and pushed the whole
page wider than a phone; and links inside running text were distinguished by
colour alone. Fixed, and the scan is now clean.

### The read path is tested against the deployed page

`npm run test:e2e` drives [lebur.vercel.app](https://lebur.vercel.app) in a real
Chromium and asserts against the live batch. `tsc` and `next build` are both clean
on code that throws the moment a browser runs it — a barrel import pulling in a
peer dependency, a viem default RPC that is dead, an ABI that no longer decodes a
deployed contract. All three have happened in this project and none was caught
before the page was opened.

Four tests, no wallet: that phase, order count, deadline and the price ladder
really come back from Sepolia through Multicall3; that the page offers exactly the
lifecycle step the batch is ready for and never the one that would revert; that
`publicFootprint` is read only once it exists, since it reverts `WrongPhase`
before settlement; and that the read-your-own-order panel appears only when there
is a book to read. A `pageerror` or `console.error` fails the run.

One of these caught its own author: the spec asserted the enum name `Open` while
the UI renders `Accepting orders`. It passed review and failed the browser, which
is the entire argument for the file existing.

```bash
cd packages/web && npm run test:e2e            # against the deployed page
BASE=http://localhost:3000 npm run test:e2e    # against your own dev server
```

## Verified source

Every address below is verified against **this branch**, so the code you are
reading and the code that is running are the same code — there is no revision gap
to explain away.

| Contract | Verified |
|---|---|
| LeburBatch — settled | [Blockscout](https://eth-sepolia.blockscout.com/address/0x6a022daacef56e7751828b17a3da3486950008b2#code) |
| LeburBatch — open | [Blockscout](https://eth-sepolia.blockscout.com/address/0x5f4a77e5d14acb63f3d344dd186d1cd9c94c0ddd#code) |
| cUSDA / cUSDB (settled batch) | [Sourcify](https://sourcify.dev/server/repo-ui/11155111/0xd9953a0fcb3ad1077bfd8978a6bdef3a3f05638b) · [Sourcify](https://sourcify.dev/server/repo-ui/11155111/0x649bca4a169a0a9bcc386e2a5e4f15aa3b238a1a) |
| cUSDA / cUSDB (open batch) | [Sourcify](https://sourcify.dev/server/repo-ui/11155111/0xc8b9721376cf230af9f4b0978ea561db571ae067) · [Sourcify](https://sourcify.dev/server/repo-ui/11155111/0x106251f45c79655f49997180323ce92af665de2a) |
| lUSDA | [Sourcify](https://sourcify.dev/server/repo-ui/11155111/0x838204BC3D82B29E3697Bfe9A17662c57943e34F) |
| lUSDB | [Sourcify](https://sourcify.dev/server/repo-ui/11155111/0x8A00F10b198f8cC9266d6E330b9792E395707CB7) |

`LeburBatch` goes to Blockscout rather than Sourcify because its constructor takes
the price ladder as an array: the `verify sourcify` task ignores
`--constructor-args-path` (it resolves libraries only) and array arguments cannot
be expressed positionally, so it can never be verified that way.
`verify blockscout` honours the args module in `verify-args.js`.

## Tests

**11 passing** against the real Nox offchain stack:

- the full round trip — sealed submit, encrypted ladder scan, gateway public
  decrypt, Curve settlement, confidential payouts — with every trader's final
  balance checked against the reference oracle to the wei
- the degraded path: when the pool cannot meet the clearing price the Curve leg is
  skipped, the residual is re-wrapped and limits are still honoured. This one
  clears **one tick per transaction**, so the same wei-exact oracle comparison also
  proves a paginated argmax agrees with a single-pass one
- nine guard tests: malformed ladders rejected at construction (empty, zero
  price, flat, descending), clearing refused before the window closes, orders
  refused after it, `payout` and `publicFootprint` refused before settlement, an
  empty book that still clears rather than trapping the batch in Open forever, and
  a paged scan that refuses a zero page, stays Open until the last tick, and can
  be finished by the unpaged entry point

```bash
cd packages/contracts && npx hardhat test   # needs Docker
```

The two suites share one Nox node, so they also share a single ~3600s budget of
`evm_increaseTime`: a `handleProof` is signed against the WALL clock while
`evm_increaseTime` moves only the CHAIN clock, and the drift persists across
files. Both suites therefore use a 60-second window and step just past it.

### The batch, settled live

Ran end to end on Sepolia 2026-07-27. Two sealed orders — bid 1000 lUSDA at tick
2, ask 600 lUSDB at tick 1 — netted inside the TEE and settled through one
`exchange_received` against the real Curve pool:

| | |
|---|---|
| clearing tick | **2** (price 1.0005 coin0 per coin1) |
| residual to the public pool | **399.7 lUSDA** / 0 lUSDB |
| Curve leg | used — received **399.652082524006769831 lUSDB** |
| `publicFootprint` | **399.7** — the total value that ever became public |

Measured gas: `clear()` **2,074,408** for the whole encrypted ladder scan,
`settle()` 950,092, `payout()` 572k each.

**600 of the 1000 crossed internally and never touched the chain.** Only the
399.7 residual did. Every order's size, side, limit and fill remain encrypted,
and the pool saw a single trade rather than two counterparties.

The numbers are also a check on the mechanism rather than just a log: a bid of
1000 at tick 2 demands `1000 / 1.0005 ≈ 999.5` coin1, the ask supplies 600, so
the residual is `≈ 399.5` coin1-equivalent — which is what cleared, and the tick
the max-volume/min-imbalance rule should pick.

## Clearing does not have to fit one transaction

A full ladder scan is `T·(6N+17)+11` sequential encrypted ops, and because nothing
can short-circuit on a secret, that is the worst case **every** time — so the
ladder and the book together used to have to fit one block, one Runner pass, one
transaction. `clearPaged(maxTicks)` scans a slice and stops; call it until the
phase flips to Cleared. `clear()` is the same thing with an unbounded page.

The carry is the whole cost: six encrypted handles per page, written down and
re-permitted, because an unlisted handle is dead in the next transaction. Pausing
mid-argmax is safe for one specific reason — paging can only begin after
`submitDeadline`, and `submitOrder` refuses past it, so every page scans its ticks
against exactly the book the first page saw. The phase stays `Open` until the last
tick lands: a half-scanned argmax holds a *leader*, not an answer, and settling on
it would clear the whole batch at the wrong price.

The e2e degraded-path test clears one tick per transaction and still matches the
reference oracle to the wei on every trader's final balance, which is the real
assertion that a boundary-crossing argmax gives the same answer as a single pass.

## One deployment, many auctions

`startNewBatch(deadline)` resets a settled batch for a new epoch, so the batcher
does not have to be redeployed per auction — each redeploy is ~3.6M gas.

It is permissionless like every other step: there is no operator here, and adding
one just to gate a reset would reintroduce the single party this design does
without. Two things make that safe. A reset requires `paidCount ==
orders.length`, because clearing the order book while any order is unpaid would
destroy the only record of that trader's escrow. And the new window is bounded to
[5 minutes, 30 days], so a caller can neither open one that closes instantly nor
park the deployment for a year.

The encrypted aggregates are deliberately *not* cleared — `clear()` overwrites
every one of them and the phase guards make them unreadable meanwhile — but the
revealed plaintext mirrors are, because those are public and a stale clearing
price would misreport an auction that has not happened yet. The e2e test asserts
exactly that after a real settlement.

## The viewing key lives inside your wallet

`packages/snap` is a MetaMask Snap that holds the **viewing key** for your orders.
It is derived from your SRP via `snap_getEntropy`, lives in the SES sandbox, and
is granted the Nox viewer role — so you can decrypt your own order inside
MetaMask and **cannot sign anything that proves it to a briber**. Without the
Snap your EOA holds that role and *can*, so the UI states which mode is active
rather than choosing silently.

### It used to encrypt orders too, and that was broken

Worth stating plainly, because it is the failure that "builds clean and passes SES
evaluation" was never going to catch, and because the fix narrows a claim this
README previously made.

`Nox.fromExternal` requires the address that **owns an input proof** to be the
direct `msg.sender` of the transaction consuming it. The Snap encrypted with its
own SRP-derived identity while `submitOrder` was sent by the user's EOA, so every
Snap-sealed order would have reverted `InvalidProof` — and the page *preferred*
the Snap when it was installed. Installing the Snap turned a working trader into a
broken one. Nothing caught it because the Snap had never been loaded in a wallet:
it compiled, it survived SES, and no test exercised the one call that could not
work.

Encryption is therefore the EOA's job — it is the only key that can satisfy
`fromExternal` — and the gateway still does it inside its own TEE. What is
genuinely lost is the claim that *the size never enters page JavaScript*: that was
an over-claim, and `fromExternal`'s binding rules it out for any wallet-signed
transaction. What survives is the property that actually mattered, which is that
nobody, including you, can produce a proof of what you traded.

```bash
cd packages/snap && npm install && npm run build && npm run serve   # localhost:8080
```

Builds clean and evaluates under SES. **Not yet loaded in MetaMask Flask** — the
bundle passing `mm-snap eval` is not the same as a wallet round trip, and that
distinction is worth keeping until someone has actually done it.
