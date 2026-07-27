# Feedback for the iExec Nox team

From building **Lebur**, a confidential uniform-price batch auction settling against
Curve StableSwap-NG on Ethereum Sepolia. Everything below is friction we actually hit
while building this project — no invented papercuts, and where something worked well
we say so rather than padding the list.

Versions: `nox-protocol-contracts@0.2.4`, `nox-confidential-contracts@0.2.2`,
`handle@0.1.0-beta.13`, `nox-hardhat-plugin@0.1.0`, Hardhat 3.4, Node 26, Windows 11.

---

## What worked better than expected

**The local stack is genuinely good.** `hardhat test` bringing up KMS, gateway,
ingestor, NATS, MinIO and the Runner, etching `NoxCompute` via `hardhat_setCode`, and
tearing it all down again is a *lot* of moving parts hidden behind one command. Both of
our end-to-end tests — encrypted submit, a 209-op encrypted ladder scan, public
decrypt, settlement, confidential payouts — run in about 11 seconds. That is a much
better developer loop than we expected from a TEE protocol.

**`ERC20ToERC7984Wrapper.unwrap` / `finalizeUnwrap` is a better primitive than the
docs let on.** `unwrap()` already marks the burn handle publicly decryptable and
`finalizeUnwrap()` verifies the gateway signature before releasing the underlying, so
"reveal this aggregate" and "turn it into a plain ERC-20" are *one* operation. That is
exactly the shape a batch settlement needs, and we built our whole reveal path on it.
It deserves to be documented as a reveal mechanism, not just as an unwrap.

**The fused `Nox.transfer/mint/burn` primitives.** Using `ERC7984` over `ERC7984Raw`
is a real, measurable saving and the choice is well explained in the source.

---

## 1. Two Nox projects cannot be built on one machine at the same time

This cost us the most time by far, and it is entirely fixable.

`COMPOSE_OPTS.cwd` in `nox-config.ts` resolves to
`<plugin>/../../offchain-services`. Docker Compose derives its project name from the
**basename** of that directory — `offchain-services` — which is *identical for every
Nox project on the machine*, because it is always the same path shape inside
`node_modules`. Meanwhile `startChain` binds a hard-coded `NOX_LOCAL_PORT = 8545`.

The result: running `hardhat test` in project B while project A's tests are running
does not merely fail with "port in use". Project B's `finally` block calls `downAll`
on what Docker considers the *same compose project*, and **tears down project A's
running stack mid-test**. We reproduced this: our first run failed the port check, and
in the process took down a sibling project's live test run.

Two independent fixes, either of which is enough:

- pass an explicit `name` in `COMPOSE_OPTS`, derived from the consuming project's own
  path (a hash of `process.cwd()` would do), so compose projects never collide;
- make `NOX_LOCAL_PORT` configurable via the plugin's network config, or fall back to
  an ephemeral port when 8545 is taken. The port number is already returned from
  `server.listen()` and threaded through to `deployNoxCompute`, so nothing downstream
  actually depends on it being 8545.

Right now the failure is silent from the victim's side, which is the worst property a
failure can have.

## 2. `evm_increaseTime` and `proofExpirationDuration` are on different clocks

A `handleProof` is signed against **wall clock** and validated against
`block.timestamp`. Any test that time-travels the chain therefore silently invalidates
every proof minted afterwards — and the drift *persists across test cases*, because
they share one node.

Our first test advanced the chain by 3601s to get past a one-hour submit window. Our
second test then failed with `Proof expired` on a proof created two seconds earlier.
The revert also arrives as an undecodable custom error (`0xae385f38`, not in the
consuming contract's ABI), so the visible symptom is a wall of hex, and the actual
message — `"Proof expired"` — is buried in the last 32 bytes of the return data.

Suggestions:

- document the interaction prominently: any auction, vesting, deadline or epoch design
  will hit it in its very first test, since those are exactly the contracts that need
  `evm_increaseTime`;
- have the plugin re-export `NoxCompute`'s error ABI so `hardhat test` can decode
  `Proof expired` into a sentence;
- consider letting the local stack's signer follow the chain clock rather than the wall
  clock, which would make the whole class of problem disappear in tests.

## 3. `require(Nox.isInitialized(fromBalance))` is a trap for any two-sided protocol

`ERC7984Base` reverts on a transfer from an account whose balance handle was never
initialised. Perfectly reasonable in isolation — but it interacts badly with the core
Nox constraint that **you cannot branch on encrypted data**.

Lebur must not know which side an order is on, so it pulls from *both* confidential
tokens and lets one pull move an encrypted zero. That reverts for any trader who has
never held the coin they are not trading. And it bit our own contract too: an all-asks
book leaves the batcher with no cToken0 balance at all, so `clear()` reverted on the
coin0 unwrap — for a batch shape that is completely legal.

We worked around it in two places: the constructor wraps zero of each coin for the
contract itself, and `_pull` skips the transfer when the counterparty's handle is
uninitialised. Both are fine, but we only found them because we went looking; the
natural implementation compiles, passes a happy-path test, and reverts in production
on the first one-sided batch.

What would help: make a transfer of an encrypted amount from an uninitialised balance
a **no-op returning encrypted zero** rather than a revert. It is already the case that
an over-balance transfer caps rather than reverts, so this would be consistent with the
existing "never revert on a value condition" philosophy — and "the balance is zero" is
a value condition. If the revert must stay, the doc comment should say plainly that
zero-amount transfers are not safe from fresh accounts.

## 4. No `select` over `ebool`, so boolean algebra has to be smuggled through integers

`select` has four overloads (`euint16`, `euint256`, `eint16`, `eint256`) but not
`ebool`, and there are no bitwise ops. So `a || (b && c)` — the shape of essentially
every tie-break, priority rule or compound eligibility test — is not directly
expressible.

Our clearing rule is "highest volume wins; on a tie, lowest imbalance wins". We ended
up packing both criteria into a single `euint256`
(`score = V·2⁹⁰ + (2⁹⁰−1 − (D1+S1))`) and comparing with one `gt`. That is actually
*cheaper* than the boolean version would have been, so we are happy with it — but it
took real thought to find, and it forced a `MAX_ORDER` clamp purely to keep the packing
overflow-free.

`select(ebool, ebool, ebool)` is one more overload of code you already have. It would
save every developer this detour. Failing that, the packing trick is worth a page in
the docs — it generalises to any lexicographic comparison.

## 5. Smaller things

- **`div` by zero saturating to MAX** is the correct choice given that reverting would
  leak, but it is *silently* catastrophic: a batch with no eligible bidders would have
  paid out `2^256 − 1` instead of reverting. We guard every denominator with
  `eq(x, 0)` + `select`. A `safeDiv` exists — it should probably be the one the docs
  reach for first, with plain `div` presented as the sharp-edged optimisation.
- **Stack too deep** in any function with more than a handful of live handles.
  `clear()` needs six argmax carries plus loop locals and hit the limit immediately.
  A memory struct fixed it, but since encrypted code is *inherently* branch-free and
  therefore variable-heavy, this will hit everyone. Worth a line in the docs
  recommending the struct pattern before people reach for `viaIR`.
- **`allowThis` on a handle you only hold transiently.** It is not obvious from the ACL
  role matrix whether a transient holder may grant itself permanent admin, and the
  answer matters constantly — every value returned by an ERC-7984 transfer arrives
  transient and usually needs storing. It works in 0.2.4. Please state that it does,
  because the role matrix reads like it should not.
- **`@iexec-nox/nox-protocol-contracts` must be a direct dependency**, not transitive,
  or `hardhat test` fails. This is documented, and we followed it — noting it only
  because the failure mode is far from the cause.
- **The docs URL moved** (`docs.iex.ec/nox-protocol/*` → `docs.noxprotocol.io`) and
  `github.com/iExec-Nox/nox-hardhat-starter`, which the hackathon brief links, is a
  404. The real equivalent is `packages/example-project` inside the
  `nox-hardhat-plugin` repo. Worth fixing in the brief, since it is the first link a
  new hacker clicks.
- **Curve on Sepolia is undocumented but alive.** Not your problem, but relevant to
  anyone building cDeFi integrations on Ethereum Sepolia: the StableSwap-NG factory at
  `0xfb37b8D939FFa77114005e61CFc2e543d6F49A81` is live with 178 pools and a codehash
  byte-identical to mainnet, even though Curve's own `/deployments/` page 404s. If
  iExec wants more Ethereum-Sepolia cDeFi submissions, publishing a short list of
  protocols that are *actually* deployed there would remove a full day of RPC
  archaeology per team.

## 6. The one thing we would ask for first

If only one item on this list can be picked up: **fix the shared compose project name
and the hard-coded port** (§1). Everything else here cost us thought; that one cost us
someone else's test run, and it will hit every team that keeps two Nox projects in one
workspace — which, at a hackathon, is most of them.
