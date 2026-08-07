// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProofFlowVault} from "../src/ProofFlowVault.sol";

contract ProofFlowVaultTest is Test {
    ProofFlowVault vault;
    address payer = makeAddr("payer");
    address recipient = makeAddr("recipient");
    bytes32 policyHash = keccak256("policy-v1");

    function setUp() public {
        vm.deal(payer, 10 ether);
        vm.deal(recipient, 1 ether);
        vault = new ProofFlowVault(payer, recipient, 1 ether, uint64(block.timestamp + 1 days), policyHash);
    }

    function testFundCommitAndReleaseOnce() public {
        vm.prank(payer);
        vault.fund{value: 1 ether}();
        vm.prank(recipient);
        vault.commitEvidence(keccak256("evidence"));
        vm.prank(payer);
        vault.release();
        assertEq(recipient.balance, 2 ether);
        assertTrue(vault.released());
        vm.prank(payer);
        vm.expectRevert(ProofFlowVault.NotReady.selector);
        vault.release();
    }

    function testCannotFundFromRecipientOrWrongAmount() public {
        vm.prank(recipient);
        vm.expectRevert(ProofFlowVault.NotPayer.selector);
        vault.fund{value: 1 ether}();
        vm.prank(payer);
        vm.expectRevert(ProofFlowVault.InvalidAmount.selector);
        vault.fund{value: 2 ether}();
    }

    function testCannotReleaseWithoutEvidence() public {
        vm.prank(payer);
        vault.fund{value: 1 ether}();
        vm.prank(payer);
        vm.expectRevert(ProofFlowVault.NotReady.selector);
        vault.release();
    }

    function testDisputeCanRefund() public {
        vm.prank(payer);
        vault.fund{value: 1 ether}();
        vm.prank(recipient);
        vault.openDispute();
        vm.prank(payer);
        vault.resolveDispute(false);
        assertEq(payer.balance, 10 ether);
        assertFalse(vault.released());
        assertFalse(vault.disputed());
        assertEq(address(vault).balance, 0);
    }

    function testRefundAfterDeadline() public {
        vm.prank(payer);
        vault.fund{value: 1 ether}();
        vm.warp(block.timestamp + 2 days);
        vm.prank(payer);
        vault.refundAfterDeadline();
        assertEq(payer.balance, 10 ether);
    }

    function testPauseBlocksActions() public {
        vm.prank(payer);
        vault.pause();
        vm.prank(payer);
        vm.expectRevert(ProofFlowVault.VaultPaused.selector);
        vault.fund{value: 1 ether}();
    }
}
