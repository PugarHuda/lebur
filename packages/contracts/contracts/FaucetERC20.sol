// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A stablecoin stand-in with an open faucet, used as the two coins of our
///         own Curve StableSwap-NG pool.
///
///         This is the ONLY simulated component in Lebur, and it is simulated because
///         Sepolia gives us no choice: of the 178 pools on the live StableSwap-NG
///         factory roughly half have `totalSupply == 0`, their coins are bespoke
///         tokens with no faucet, and none of them holds canonical Sepolia USDC. A
///         faucet ERC-20 behind a real, unmodified factory-deployed pool is the
///         standard testnet answer. Nothing on the confidential path is simulated:
///         the auction runs on live Nox, and the settlement leg is a real
///         `exchange_received` against real Curve bytecode.
contract FaucetERC20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        ERC20(name_, symbol_)
    {
        _dec = decimals_;
    }

    function mint(address to, uint256 amount) external {
        require(amount <= 1_000_000e18, "faucet cap");
        _mint(to, amount);
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }
}
