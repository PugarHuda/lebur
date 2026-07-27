// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

/// @notice The slice of Curve StableSwap-NG that Lebur touches. Both contracts are
///         Vyper, live and UNMODIFIED on Ethereum Sepolia; the factory's codehash is
///         byte-identical to mainnet (0xb78c1b32cd364260f3fa497ccc7e98c73cdc26bdae2d3635e763ee8b59a1d6fd),
///         which a judge can check with one eth_getCode.
///
///         Factory        0xfb37b8D939FFa77114005e61CFc2e543d6F49A81  (178 pools)
///         Pool blueprint 0xE12374F193f91f71CE40D53E0db102eBaA9098D5
///
///         There is no Router NG and no AddressProvider on Sepolia, so Lebur talks to
///         the pool directly. Curve's docs never mention Sepolia at all.
interface ICurvePool {
    /// @notice THE SETTLEMENT SEAM. Swaps against the pool's own balance delta, so the
    ///         caller transfers the input in first and then calls this: no approval,
    ///         no allowance, no transferFrom. One hop saved per batch, and the batcher
    ///         never grants the pool a standing spend permission over its escrow.
    /// @dev Note `_dx` is trusted only insofar as it must not exceed the delta the pool
    ///      actually observes — the pool checks that itself.
    function exchange_received(
        int128 i,
        int128 j,
        uint256 _dx,
        uint256 _min_dy,
        address _receiver
    ) external returns (uint256);

    function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256);
    function coins(uint256 i) external view returns (address);
    function balances(uint256 i) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function A() external view returns (uint256);
    function add_liquidity(uint256[] calldata _amounts, uint256 _min_mint_amount)
        external
        returns (uint256);
}

interface ICurveStableSwapNGFactory {
    /// @dev Deploys a fresh pool from the on-chain blueprint. No Vyper toolchain
    ///      needed — factory and blueprint are already live. `_implementation_idx` 0
    ///      is the plain-pool blueprint above.
    function deploy_plain_pool(
        string calldata _name,
        string calldata _symbol,
        address[] calldata _coins,
        uint256 _A,
        uint256 _fee,
        uint256 _offpeg_fee_multiplier,
        uint256 _ma_exp_time,
        uint256 _implementation_idx,
        uint8[] calldata _asset_types,
        bytes4[] calldata _method_ids,
        address[] calldata _oracles
    ) external returns (address);

    function pool_count() external view returns (uint256);
    function pool_list(uint256 i) external view returns (address);
}
