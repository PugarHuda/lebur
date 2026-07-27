// Curve StableSwap-NG on Ethereum Sepolia. Verified by direct RPC — Curve's own docs
// return 404 for /deployments/ and never mention Sepolia, so these came from
// eth_getCode / eth_call, not from documentation. Re-check with scripts/verify-curve.ts.
export const ICURVE_FACTORY = '0xfb37b8D939FFa77114005e61CFc2e543d6F49A81' as const;
export const CURVE_BLUEPRINT = '0xE12374F193f91f71CE40D53E0db102eBaA9098D5' as const;
export const CURVE_MATH = '0x2Cad7B3e78E10BcbF2Cc443ddd69ca8bCC09a758' as const;
export const CURVE_VIEWS = '0x9d3975070768580f755D405527862ee126d0eA08' as const;

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
