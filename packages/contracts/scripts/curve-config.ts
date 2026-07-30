// Curve StableSwap-NG on Ethereum Sepolia. Verified by direct RPC — Curve's own docs
// return 404 for /deployments/ and never mention Sepolia, so these came from
// eth_getCode / eth_call, not from documentation. Re-check with scripts/verify-curve.ts.
export const ICURVE_FACTORY = '0xfb37b8D939FFa77114005e61CFc2e543d6F49A81' as const;
export const CURVE_BLUEPRINT = '0xE12374F193f91f71CE40D53E0db102eBaA9098D5' as const;
export const CURVE_MATH = '0x2Cad7B3e78E10BcbF2Cc443ddd69ca8bCC09a758' as const;
export const CURVE_VIEWS = '0x9d3975070768580f755D405527862ee126d0eA08' as const;

/// THE claim to check, and the one iExec's team pointed at: the POOL
/// IMPLEMENTATION, not the factory. `exchange_received` lives on the pool, so the
/// pool blueprint is what has to be unmodified for the settlement seam to be
/// unmodified. Verified byte-identical against mainnet's `pool_implementations(0)`
/// (0xDCc91f930b42619377C200BA05b7513f2958b202), 24,031 bytes on both chains.
///
/// Do NOT compare two DEPLOYED pools instead: Vyper blueprint deployment bakes
/// constructor-time immutables (coins, decimals, name, symbol) into the runtime,
/// so our pool is 23,635 bytes against a mainnet pool's 23,482 and the hashes
/// differ. That difference is configuration, not modification, and comparing at
/// that level would read as a modified protocol when nothing is modified.
export const MAINNET_BLUEPRINT_CODEHASH =
  '0xe2a3dd8d583b86eb7f562b4307aab6e5a373ddb5c6b348e4cf63d41914f35a9f';

/// A second, weaker data point. The factory only deploys; it is not on the
/// settlement path.
/// The Sepolia factory's codehash is byte-identical to the mainnet StableSwap-NG
/// factory. That equality is the whole "unmodified Curve" claim, checkable in seconds.
export const MAINNET_FACTORY_CODEHASH =
  '0xb78c1b32cd364260f3fa497ccc7e98c73cdc26bdae2d3635e763ee8b59a1d6fd' as const;

/// Nox on Ethereum Sepolia — verified live 2026-07-22.
export const NOX_COMPUTE = '0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF' as const;
export const NOX_GATEWAY = 'https://gateway-testnets.noxprotocol.dev' as const;

/// Parameters for our own plain pool. A=200/fee=1bp is Curve's normal stable pair
/// shape; `_implementation_idx` 0 selects the plain-pool blueprint above.
export const POOL_PARAMS = {
  A: 200n,
  fee: 1_000_000n,                 // 0.01% in 1e10 units
  offpegFeeMultiplier: 20_000_000_000n,
  maExpTime: 866n,
  implementationIdx: 0n,
} as const;

/// The public price ladder the auction clears on: coin0 per coin1, WAD-scaled,
/// strictly increasing. T=4 keeps clear() inside the live-demo envelope (the Nox
/// Runner is single-threaded, so op count is wall-clock). Must match the ladder in
/// reference/lebur-reference.mjs.
export const LADDER = [
  999_500_000_000_000_000n,   // 0.9995
  1_000_000_000_000_000_000n, // 1.0000
  1_000_500_000_000_000_000n, // 1.0005
  1_001_000_000_000_000_000n, // 1.0010
] as const;
