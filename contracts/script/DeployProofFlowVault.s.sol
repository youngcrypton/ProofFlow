// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ProofFlowVault} from "../src/ProofFlowVault.sol";

contract DeployProofFlowVault is Script {
    uint256 internal constant XLAYER_TESTNET_CHAIN_ID = 1952;
    uint256 internal constant XLAYER_MAINNET_CHAIN_ID = 196;

    function run() external returns (ProofFlowVault vault) {
        uint256 chainId = block.chainid;
        require(chainId == XLAYER_TESTNET_CHAIN_ID || chainId == XLAYER_MAINNET_CHAIN_ID, "unsupported X Layer chain");

        address payer = vm.envAddress("PROOFFLOW_PAYER");
        address recipient = vm.envAddress("PROOFFLOW_RECIPIENT");
        uint256 amount = vm.envUint("PROOFFLOW_AMOUNT_BASE_UNITS");
        uint64 deadline = uint64(vm.envUint("PROOFFLOW_DEADLINE_UNIX"));
        bytes32 policyHash = vm.envBytes32("PROOFFLOW_POLICY_HASH");
        uint256 deployerKey = vm.envUint("PROOFFLOW_DEPLOYER_PRIVATE_KEY");

        require(payer != address(0) && recipient != address(0), "zero participant");
        require(amount > 0, "zero amount");
        require(deadline > block.timestamp, "deadline must be in future");
        require(deployerKey != 0, "missing deployer key");

        vm.startBroadcast(deployerKey);
        vault = new ProofFlowVault(payer, recipient, amount, deadline, policyHash);
        vm.stopBroadcast();

        console2.log("ProofFlowVault", address(vault));
        console2.log("chainId", chainId);
        console2.log("payer", payer);
        console2.log("recipient", recipient);
        console2.log("amount", amount);
        console2.log("deadline", deadline);
        console2.logBytes32(policyHash);
    }
}
