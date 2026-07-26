# Lebur — confidential uniform-price batch auction on Curve

**Not started.** This folder is the second hackathon submission. Everything below
is the decision record carried over from the shared [`BRIEF.md`](../BRIEF.md)
(§7.3, §9) so the build can start without re-doing the research.

## The idea

N sealed bids settle at one uniform clearing price against an **unmodified**
Curve StableSwap-NG pool. Bid sizes and identities stay encrypted end-to-end via
iExec Nox; only the batch residual touches the public pool.

**Privacy pattern: (B) Batch** — say this out loud in the demo video. N private
intents net against each other inside our contract; only the residual settles
publicly. Claiming a single user's single trade is hidden from a public protocol
would be a lie, and iExec's judges know the difference.

## Why this is the harder of the two projects

The encrypted **clearing tick** is the crux: each order's contribution must be
carried *through* the argmax reduction (+N ops per tick), and pro-rata fills need
`mul` before `div`, leaving sub-atto dust that has to go somewhere deliberate.

Op budget measured against the real cost model: `T=8, N=5` → ~470 ops;
`T=16, N=8` → ~1430. The Nox Runner is single-threaded with no batching, so the
live-demo envelope is **T=4/N=3 comfortable, T=8/N=5 borderline** — anything
larger must be pre-recorded. Lirih's real numbers are the calibration point: a
2.05M-gas `contribute` with a 164-op encrypted sqrt, and gateway encrypt ≈2.3s.

## Verified Sepolia ground truth (RPC-confirmed 2026-07-21)

| Contract | Address |
|---|---|
| StableSwap-NG Factory | `0xfb37b8D939FFa77114005e61CFc2e543d6F49A81` (178 pools) |
| Twocrypto-NG Factory | `0x98EE851a00abeE0d95D08cF4CA2BdCE32aeaAF7F` (46 pools) |
| Math impl | `0x2Cad7B3e78E10BcbF2Cc443ddd69ca8bCC09a758` |
| Views impl | `0x9d3975070768580f755D405527862ee126d0eA08` |
| Pool blueprint | `0xE12374F193f91f71CE40D53E0db102eBaA9098D5` |

Curve's own docs never mention Sepolia (`/deployments/` 404) — which is why zero
other submissions found it. The factory **codehash is byte-identical to
mainnet** (`0xb78c1b32cd364260f3fa497ccc7e98c73cdc26bdae2d3635e763ee8b59a1d6fd`),
so a judge can verify "unmodified" in ten seconds. No Router NG / AddressProvider
/ Tricrypto-NG on Sepolia.

**Deploy your own pool** — 1–2 hours, no Vyper toolchain needed (factory +
blueprint are already live, just call `deploy_plain_pool`, already dry-run via
`eth_call`). Do **not** borrow an existing pool: ~half of the 178 have
`totalSupply == 0`, tokens are bespoke with no faucet, and no pool holds official
Sepolia USDC.

## The settlement seam

`exchange_received(int128 i, int128 j, uint256 _dx, uint256 _min_dy, address _receiver)`
swaps on the pool's own balance delta — so the batcher just `transfer`s in and
swaps: **no approval, no `transferFrom`**, one hop saved per epoch. Also useful:
`add_liquidity`, `remove_liquidity_one_coin`, `remove_liquidity_imbalance` (the
last one is handy for netting).

## Honest framing

Curve's curve is flat near the peg, so the post-netting residual settles ~1:1.
That also means the slippage saving is small. Pitch it as **"confidentiality and
MEV resistance at institutional size, settling at par"** — *not* "we save you
slippage."

## Known risks before committing

- **Mechanism collision with Occulta** (BUIDL 47139, the strongest competitor):
  they also net intents and reveal one aggregate trade per epoch. Different
  protocol, but it can read as a variation on one theme. Lirih does not have this
  problem — worth weighing which project gets the remaining hours.
- Highest "silent risk" rating of the five ideas explored, and the tightest demo
  envelope.

## Reusable from Lirih

`Isqrt.sol` (encrypted integer sqrt), the `cUSDC` wrapper pattern, the Hardhat 3
+ Nox plugin setup, the `donate.ts`/`seed-round.ts` script shape, and the pinned
gas config. Copy, don't import across project folders — each submission must
stand alone.
