// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";

/// @notice TEST HARNESS ONLY — a stand-in for the real Curve StableSwap-NG pool, used
///         by `hardhat test` because Curve exists on Sepolia but not on a fresh EDR
///         node. The live deployment settles against the real Vyper pool at the
///         address the factory returns; nothing in `LeburBatch.sol` knows the
///         difference, it only ever sees `ICurvePool`.
///
///         This is a test double for an EXTERNAL protocol, not a stub of Lebur's own
///         confidential path. The auction math, the Nox compute and the ERC-7984
///         escrow are the real thing in every test.
///
/// @dev Deliberately NOT a StableSwap reimplementation. Porting the D-invariant would
///      add sixty lines of Newton iteration whose only job is to be a slightly
///      prettier fake — and a fake whose correctness could not be checked against the
///      real pool anyway. Instead this is constant-sum with a flat fee, which is what
///      StableSwap converges to at the peg, plus a settable fee so a test can force
///      the pool BELOW the auction's `_min_dy` and exercise the skip path. The
///      auction's own invariants are proven against arbitrary pool output in
///      reference/lebur-reference.mjs, so the pool's exact shape is not load-bearing.
contract MockCurvePool {
    address[2] public coinList;
    uint256[2] public reserve;
    uint256 public feeWad; // output multiplier in 1e18 units: 0.9999e18 == 1bp fee

    constructor(address a, address b, uint256 feeWad_) {
        coinList[0] = a;
        coinList[1] = b;
        feeWad = feeWad_;
    }

    function coins(uint256 i) external view returns (address) {
        return coinList[i];
    }

    function balances(uint256 i) external view returns (uint256) {
        return reserve[i];
    }

    function totalSupply() external view returns (uint256) {
        return reserve[0] + reserve[1];
    }

    function A() external pure returns (uint256) {
        return 200;
    }

    function setFeeWad(uint256 f) external {
        feeWad = f;
    }

    function get_dy(int128, int128 j, uint256 dx) public view returns (uint256) {
        uint256 out = (dx * feeWad) / 1e18;
        uint256 have = reserve[uint256(int256(j))];
        return out > have ? have : out;
    }

    function add_liquidity(uint256[] calldata amounts, uint256) external returns (uint256) {
        for (uint256 k; k < 2; ++k) {
            if (amounts[k] == 0) continue;
            require(IERC20(coinList[k]).transferFrom(msg.sender, address(this), amounts[k]), "tf");
            reserve[k] += amounts[k];
        }
        return amounts[0] + amounts[1];
    }

    /// @dev Mirrors the real semantics that Lebur depends on: the swap is priced off
    ///      the pool's OWN balance delta, so the caller transfers in first and this
    ///      never calls transferFrom. Under-delivering reverts, exactly as Curve does.
    function exchange_received(int128 i, int128 j, uint256 dx, uint256 minDy, address receiver)
        external
        returns (uint256)
    {
        uint256 ii = uint256(int256(i));
        uint256 jj = uint256(int256(j));
        require(ii != jj, "same coin");
        uint256 received = IERC20(coinList[ii]).balanceOf(address(this)) - reserve[ii];
        require(received >= dx, "not received");
        uint256 dy = get_dy(i, j, dx);
        require(dy >= minDy, "slippage");
        reserve[ii] += received;
        reserve[jj] -= dy;
        require(IERC20(coinList[jj]).transfer(receiver, dy), "tf out");
        return dy;
    }
}
