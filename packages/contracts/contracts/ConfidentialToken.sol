// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {ERC20ToERC7984Wrapper} from
    "@iexec-nox/nox-confidential-contracts/contracts/token/extensions/ERC20ToERC7984Wrapper.sol";

/// @notice Confidential wrapper over a plaintext ERC-20, 1:1. Uses iExec's own
///         `ERC20ToERC7984Wrapper` (the gas-optimised variant, built on the fused
///         `Nox.transfer/mint/burn` primitives) — no hand-rolled ERC-7984.
///
/// @dev The privacy boundary is worth stating precisely, because it is easy to
///      overclaim: `wrap()` takes a PLAINTEXT amount in calldata, so wrapping is
///      public. What stays confidential is everything after — your order size, your
///      side, your limit and your fill. In practice a trader wraps a round number
///      well ahead of the batch and then trades an arbitrary secret slice of it.
///
/// @dev Lebur relies on one more property of this wrapper: `unwrap()` marks the burn
///      handle publicly decryptable and `finalizeUnwrap()` verifies the gateway
///      signature before releasing the underlying. That IS Lebur's residual-reveal
///      mechanism — the batch never needs a separate decrypt-and-trust step, because
///      the only value it has to publish is the one the unwrap already publishes.
contract ConfidentialToken is ERC20ToERC7984Wrapper {
    constructor(string memory name_, string memory symbol_, IERC20 underlying)
        ERC20ToERC7984Wrapper(name_, symbol_, "", underlying)
    {}
}
