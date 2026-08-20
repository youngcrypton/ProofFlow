// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {ProofFlowVault} from "../src/ProofFlowVault.sol";

contract ForceSend {
    constructor() payable {}

    function destroy(address payable recipient_) external {
        selfdestruct(recipient_);
    }
}

contract RejectingReceiver {
    receive() external payable {
        revert("reject ether");
    }
}

contract RejectingPayer {
    ProofFlowVault public vault;

    receive() external payable {
        revert("reject ether");
    }

    function setVault(ProofFlowVault vault_) external {
        vault = vault_;
    }

    function fundVault(uint256 value) external {
        vault.fund{value: value}();
    }

    function openDispute() external {
        vault.openDispute();
    }

    function resolveRefund() external {
        vault.resolveDispute(false);
    }

    function refundAfterDeadline() external {
        vault.refundAfterDeadline();
    }
}

contract ReentrantRecipient {
    ProofFlowVault public vault;
    bool public attempted;

    function setVault(ProofFlowVault vault_) external {
        vault = vault_;
    }

    receive() external payable {
        attempted = true;
        (bool success,) = address(vault).call(abi.encodeCall(ProofFlowVault.release, ()));
        require(!success, "reentrant release succeeded");
    }
}

contract ReentrantPayer {
    ProofFlowVault public vault;
    bool public attempted;

    function setVault(ProofFlowVault vault_) external {
        vault = vault_;
    }

    function fundVault() external {
        vault.fund{value: 1 ether}();
    }

    function refundAfterDeadline() external {
        vault.refundAfterDeadline();
    }

    function openDispute() external {
        vault.openDispute();
    }

    function resolveRefund() external {
        vault.resolveDispute(false);
    }

    receive() external payable {
        attempted = true;
        (bool success,) = address(vault).call(abi.encodeCall(ProofFlowVault.refundAfterDeadline, ()));
        require(!success, "reentrant refund succeeded");
    }
}

contract ReentrantDisputeRecipient {
    ProofFlowVault public vault;
    bool public attempted;

    function setVault(ProofFlowVault vault_) external {
        vault = vault_;
    }

    function openDispute() external {
        vault.openDispute();
    }

    receive() external payable {
        attempted = true;
        (bool success,) = address(vault).call(abi.encodeCall(ProofFlowVault.resolveDispute, (true)));
        require(!success, "reentrant dispute release succeeded");
    }
}

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

    function testForcedEtherCannotIncreaseReleasePayout() public {
        vm.prank(payer);
        vault.fund{value: 1 ether}();
        ForceSend forceSend = new ForceSend{value: 0.5 ether}();
        forceSend.destroy(payable(address(vault)));
        vm.prank(recipient);
        vault.commitEvidence(keccak256("evidence"));
        vm.prank(payer);
        vault.release();
        assertEq(recipient.balance, 2 ether);
        assertEq(address(vault).balance, 0.5 ether);
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
        assertEq(uint256(vault.state()), uint256(ProofFlowVault.VaultState.REFUNDED));
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

    function testDisputePayerOutcomeBecomesRefunded() public {
        _fundAndDispute();
        vm.prank(payer);
        vault.resolveDispute(false);
        assertEq(uint256(vault.state()), uint256(ProofFlowVault.VaultState.REFUNDED));
        assertFalse(vault.released());
        assertFalse(vault.disputed());
    }

    function testRefundAfterDeadlineBecomesRefunded() public {
        _fund();
        vm.warp(uint256(vault.deadline()) + 1);
        vm.prank(payer);
        vault.refundAfterDeadline();
        assertEq(uint256(vault.state()), uint256(ProofFlowVault.VaultState.REFUNDED));
        assertFalse(vault.released());
    }

    function testCannotReleaseAfterDisputeRefund() public {
        _fundAndDispute();
        vm.prank(payer);
        vault.resolveDispute(false);
        vm.prank(payer);
        vm.expectRevert(ProofFlowVault.NotReady.selector);
        vault.release();
    }

    function testCannotRefundAfterRelease() public {
        _fundCommitAndRelease();
        vm.warp(uint256(vault.deadline()) + 1);
        vm.prank(payer);
        vm.expectRevert(ProofFlowVault.NotReady.selector);
        vault.refundAfterDeadline();
    }

    function testCannotRefundTwice() public {
        _fund();
        vm.warp(uint256(vault.deadline()) + 1);
        vm.prank(payer);
        vault.refundAfterDeadline();
        vm.prank(payer);
        vm.expectRevert(ProofFlowVault.NotReady.selector);
        vault.refundAfterDeadline();
    }

    function testCannotDisputeAfterRefund() public {
        _fund();
        vm.warp(uint256(vault.deadline()) + 1);
        vm.prank(payer);
        vault.refundAfterDeadline();
        vm.prank(recipient);
        vm.expectRevert(ProofFlowVault.NotReady.selector);
        vault.openDispute();
    }

    function testCannotDisputeAfterRelease() public {
        _fundCommitAndRelease();
        vm.prank(recipient);
        vm.expectRevert(ProofFlowVault.NotReady.selector);
        vault.openDispute();
    }

    function testCannotCommitEvidenceAfterRefund() public {
        _fund();
        vm.warp(uint256(vault.deadline()) + 1);
        vm.prank(payer);
        vault.refundAfterDeadline();
        vm.prank(recipient);
        vm.expectRevert(ProofFlowVault.NotReady.selector);
        vault.commitEvidence(keccak256("late evidence"));
    }

    function testCannotCommitEvidenceAfterRelease() public {
        _fundCommitAndRelease();
        vm.prank(recipient);
        vm.expectRevert(ProofFlowVault.NotReady.selector);
        vault.commitEvidence(keccak256("late evidence"));
    }

    function testCannotFundAfterRefund() public {
        _fund();
        vm.warp(uint256(vault.deadline()) + 1);
        vm.prank(payer);
        vault.refundAfterDeadline();
        vm.deal(payer, 1 ether);
        vm.prank(payer);
        vm.expectRevert(ProofFlowVault.AlreadyFunded.selector);
        vault.fund{value: 1 ether}();
    }

    function testCannotFundAfterRelease() public {
        _fundCommitAndRelease();
        vm.deal(payer, 1 ether);
        vm.prank(payer);
        vm.expectRevert(ProofFlowVault.AlreadyFunded.selector);
        vault.fund{value: 1 ether}();
    }

    function testDisputeRecipientOutcomeBecomesReleased() public {
        _fundAndDispute();
        vm.prank(payer);
        vault.resolveDispute(true);
        assertEq(uint256(vault.state()), uint256(ProofFlowVault.VaultState.RELEASED));
        assertTrue(vault.released());
        assertEq(recipient.balance, 2 ether);
    }

    function testConstructorRejectsDeadlineEqualToTimestamp() public {
        vm.expectRevert(ProofFlowVault.InvalidDeadline.selector);
        new ProofFlowVault(payer, recipient, 1 ether, uint64(block.timestamp), policyHash);
    }

    function testConstructorRejectsDeadlineBeforeTimestamp() public {
        vm.expectRevert(ProofFlowVault.InvalidDeadline.selector);
        new ProofFlowVault(payer, recipient, 1 ether, uint64(block.timestamp - 1), policyHash);
    }

    function testConstructorAcceptsDeadlineOneSecondAfterTimestamp() public {
        ProofFlowVault nextVault =
            new ProofFlowVault(payer, recipient, 1 ether, uint64(block.timestamp + 1), policyHash);
        assertEq(nextVault.deadline(), block.timestamp + 1);
    }

    function testRefundRejectedExactlyAtDeadline() public {
        _fund();
        vm.warp(vault.deadline());
        vm.prank(payer);
        vm.expectRevert(ProofFlowVault.NotReady.selector);
        vault.refundAfterDeadline();
    }

    function testRefundAllowedOneSecondAfterDeadline() public {
        _fund();
        vm.warp(uint256(vault.deadline()) + 1);
        vm.prank(payer);
        vault.refundAfterDeadline();
        assertEq(uint256(vault.state()), uint256(ProofFlowVault.VaultState.REFUNDED));
    }

    function testReleaseTransferFailureRevertsState() public {
        RejectingReceiver rejectingRecipient = new RejectingReceiver();
        ProofFlowVault rejectingVault = new ProofFlowVault(
            payer, address(rejectingRecipient), 1 ether, uint64(block.timestamp + 1 days), policyHash
        );
        vm.prank(payer);
        rejectingVault.fund{value: 1 ether}();
        vm.prank(payer);
        rejectingVault.commitEvidence(keccak256("evidence"));
        vm.prank(payer);
        vm.expectRevert(ProofFlowVault.TransferFailed.selector);
        rejectingVault.release();
        assertEq(uint256(rejectingVault.state()), uint256(ProofFlowVault.VaultState.FUNDED));
        assertEq(address(rejectingVault).balance, 1 ether);
    }

    function testDisputeRefundTransferFailureRevertsState() public {
        RejectingPayer rejectingPayer = new RejectingPayer();
        vm.deal(address(rejectingPayer), 1 ether);
        ProofFlowVault rejectingVault = new ProofFlowVault(
            address(rejectingPayer), recipient, 1 ether, uint64(block.timestamp + 1 days), policyHash
        );
        rejectingPayer.setVault(rejectingVault);
        rejectingPayer.fundVault(1 ether);
        rejectingPayer.openDispute();
        vm.expectRevert(ProofFlowVault.TransferFailed.selector);
        rejectingPayer.resolveRefund();
        assertEq(uint256(rejectingVault.state()), uint256(ProofFlowVault.VaultState.DISPUTED));
        assertEq(address(rejectingVault).balance, 1 ether);
    }

    function testDeadlineRefundTransferFailureRevertsState() public {
        RejectingPayer rejectingPayer = new RejectingPayer();
        vm.deal(address(rejectingPayer), 1 ether);
        ProofFlowVault rejectingVault =
            new ProofFlowVault(address(rejectingPayer), recipient, 1 ether, uint64(block.timestamp + 1), policyHash);
        rejectingPayer.setVault(rejectingVault);
        rejectingPayer.fundVault(1 ether);
        vm.warp(uint256(rejectingVault.deadline()) + 1);
        vm.expectRevert(ProofFlowVault.TransferFailed.selector);
        rejectingPayer.refundAfterDeadline();
        assertEq(uint256(rejectingVault.state()), uint256(ProofFlowVault.VaultState.FUNDED));
        assertEq(address(rejectingVault).balance, 1 ether);
    }

    function testReceiveFundsWithCorrectPayerAndExactAmount() public {
        vm.prank(payer);
        (bool success,) = address(vault).call{value: 1 ether}("");
        assertTrue(success);
        assertEq(uint256(vault.state()), uint256(ProofFlowVault.VaultState.FUNDED));
    }

    function testReceiveRejectsIncorrectAmount() public {
        vm.prank(payer);
        (bool success, bytes memory data) = address(vault).call{value: 0.5 ether}("");
        assertFalse(success);
        assertEq(data, abi.encodeWithSelector(ProofFlowVault.InvalidAmount.selector));
    }

    function testReceiveRejectsUnauthorizedSender() public {
        vm.prank(recipient);
        vm.expectRevert(ProofFlowVault.NotPayer.selector);
        payable(address(vault)).transfer(1 ether);
    }

    function testReceiveRejectsDuplicateFunding() public {
        _fund();
        vm.deal(payer, 1 ether);
        vm.prank(payer);
        vm.expectRevert(ProofFlowVault.AlreadyFunded.selector);
        payable(address(vault)).transfer(1 ether);
    }

    function testReentrantRecipientCannotReleaseTwice() public {
        ReentrantRecipient reentrantRecipient = new ReentrantRecipient();
        ProofFlowVault reentrantVault = new ProofFlowVault(
            payer, address(reentrantRecipient), 1 ether, uint64(block.timestamp + 1 days), policyHash
        );
        reentrantRecipient.setVault(reentrantVault);
        vm.prank(payer);
        reentrantVault.fund{value: 1 ether}();
        vm.prank(payer);
        reentrantVault.commitEvidence(keccak256("evidence"));
        vm.prank(payer);
        reentrantVault.release();
        assertTrue(reentrantRecipient.attempted());
        assertEq(address(reentrantRecipient).balance, 1 ether);
        assertEq(uint256(reentrantVault.state()), uint256(ProofFlowVault.VaultState.RELEASED));
    }

    function testReentrantPayerCannotRefundTwice() public {
        ReentrantPayer reentrantPayer = new ReentrantPayer();
        vm.deal(address(reentrantPayer), 1 ether);
        ProofFlowVault reentrantVault =
            new ProofFlowVault(address(reentrantPayer), recipient, 1 ether, uint64(block.timestamp + 1), policyHash);
        reentrantPayer.setVault(reentrantVault);
        reentrantPayer.fundVault();
        vm.warp(uint256(reentrantVault.deadline()) + 1);
        reentrantPayer.refundAfterDeadline();
        assertTrue(reentrantPayer.attempted());
        assertEq(address(reentrantPayer).balance, 1 ether);
        assertEq(uint256(reentrantVault.state()), uint256(ProofFlowVault.VaultState.REFUNDED));
    }

    function testUnauthorizedCallersCannotChangeState() public {
        address outsider = makeAddr("outsider");
        vm.deal(outsider, 2 ether);

        vm.prank(outsider);
        vm.expectRevert(ProofFlowVault.NotPayer.selector);
        vault.fund{value: 1 ether}();

        _fund();
        ProofFlowVault.VaultState fundedState = vault.state();

        vm.prank(outsider);
        vm.expectRevert(ProofFlowVault.NotReady.selector);
        vault.commitEvidence(keccak256("unauthorized evidence"));
        assertEq(uint256(vault.state()), uint256(fundedState));

        vm.prank(outsider);
        vm.expectRevert(ProofFlowVault.NotPayer.selector);
        vault.release();
        assertEq(uint256(vault.state()), uint256(fundedState));

        vm.prank(outsider);
        vm.expectRevert(ProofFlowVault.NotReady.selector);
        vault.openDispute();
        assertEq(uint256(vault.state()), uint256(fundedState));

        vm.prank(recipient);
        vault.openDispute();
        ProofFlowVault.VaultState disputedState = vault.state();

        vm.prank(outsider);
        vm.expectRevert(ProofFlowVault.NotReady.selector);
        vault.resolveDispute(true);
        assertEq(uint256(vault.state()), uint256(disputedState));

        vm.warp(uint256(vault.deadline()) + 1);
        vm.prank(outsider);
        vm.expectRevert(ProofFlowVault.NotReady.selector);
        vault.refundAfterDeadline();
        assertEq(uint256(vault.state()), uint256(disputedState));

        vm.prank(outsider);
        vm.expectRevert(ProofFlowVault.NotPayer.selector);
        vault.pause();
        vm.prank(outsider);
        vm.expectRevert(ProofFlowVault.NotPayer.selector);
        vault.unpause();
        assertEq(uint256(vault.state()), uint256(disputedState));
        assertFalse(vault.paused());
    }

    function testDisputeReleaseTransferFailureRevertsState() public {
        RejectingReceiver rejectingRecipient = new RejectingReceiver();
        ProofFlowVault rejectingVault = new ProofFlowVault(
            payer, address(rejectingRecipient), 1 ether, uint64(block.timestamp + 1 days), policyHash
        );
        vm.prank(payer);
        rejectingVault.fund{value: 1 ether}();
        vm.prank(payer);
        rejectingVault.openDispute();

        vm.prank(payer);
        vm.expectRevert(ProofFlowVault.TransferFailed.selector);
        rejectingVault.resolveDispute(true);

        assertEq(uint256(rejectingVault.state()), uint256(ProofFlowVault.VaultState.DISPUTED));
        assertEq(address(rejectingVault).balance, 1 ether);
        assertEq(address(rejectingRecipient).balance, 0);
        assertFalse(rejectingVault.released());
        assertTrue(rejectingVault.disputed());
    }

    function testReentrantRecipientCannotResolveDisputeTwice() public {
        ReentrantDisputeRecipient participant = new ReentrantDisputeRecipient();
        vm.deal(address(participant), 1 ether);
        ProofFlowVault reentrantVault = new ProofFlowVault(
            address(participant), address(participant), 1 ether, uint64(block.timestamp + 1 days), policyHash
        );
        participant.setVault(reentrantVault);
        vm.prank(address(participant));
        reentrantVault.fund{value: 1 ether}();
        participant.openDispute();
        vm.prank(address(participant));
        reentrantVault.resolveDispute(true);

        assertTrue(participant.attempted());
        assertEq(address(participant).balance, 1 ether);
        assertEq(uint256(reentrantVault.state()), uint256(ProofFlowVault.VaultState.RELEASED));
    }

    function testReentrantPayerCannotCallRefundAfterDeadlineDuringDisputeRefund() public {
        ReentrantPayer reentrantPayer = new ReentrantPayer();
        vm.deal(address(reentrantPayer), 1 ether);
        ProofFlowVault reentrantVault = new ProofFlowVault(
            address(reentrantPayer), recipient, 1 ether, uint64(block.timestamp + 1 days), policyHash
        );
        reentrantPayer.setVault(reentrantVault);
        reentrantPayer.fundVault();
        reentrantPayer.openDispute();
        reentrantPayer.resolveRefund();

        assertTrue(reentrantPayer.attempted());
        assertEq(address(reentrantPayer).balance, 1 ether);
        assertEq(uint256(reentrantVault.state()), uint256(ProofFlowVault.VaultState.REFUNDED));
    }

    function testReceiveRejectsFundingAfterRelease() public {
        _fundCommitAndRelease();
        vm.deal(payer, 1 ether);
        vm.prank(payer);
        (bool success, bytes memory data) = address(vault).call{value: 1 ether}("");
        assertFalse(success);
        assertEq(data, abi.encodeWithSelector(ProofFlowVault.AlreadyFunded.selector));
    }

    function testReceiveRejectsFundingAfterRefund() public {
        _fund();
        vm.warp(uint256(vault.deadline()) + 1);
        vm.prank(payer);
        vault.refundAfterDeadline();
        vm.deal(payer, 1 ether);
        vm.prank(payer);
        (bool success, bytes memory data) = address(vault).call{value: 1 ether}("");
        assertFalse(success);
        assertEq(data, abi.encodeWithSelector(ProofFlowVault.AlreadyFunded.selector));
    }

    function testConstructorRejectsZeroPayer() public {
        vm.expectRevert(ProofFlowVault.InvalidRecipient.selector);
        new ProofFlowVault(address(0), recipient, 1 ether, uint64(block.timestamp + 1), policyHash);
    }

    function testConstructorRejectsZeroRecipient() public {
        vm.expectRevert(ProofFlowVault.InvalidRecipient.selector);
        new ProofFlowVault(payer, address(0), 1 ether, uint64(block.timestamp + 1), policyHash);
    }

    function testConstructorRejectsZeroAmount() public {
        vm.expectRevert(ProofFlowVault.InvalidAmount.selector);
        new ProofFlowVault(payer, recipient, 0, uint64(block.timestamp + 1), policyHash);
    }

    function testRefundRejectedOneSecondBeforeDeadline() public {
        _fund();
        vm.warp(uint256(vault.deadline()) - 1);
        vm.prank(payer);
        vm.expectRevert(ProofFlowVault.NotReady.selector);
        vault.refundAfterDeadline();
    }

    function testCannotResolveDisputeTwiceAfterRelease() public {
        _fundAndDispute();
        vm.prank(payer);
        vault.resolveDispute(true);
        vm.prank(payer);
        vm.expectRevert(ProofFlowVault.NotReady.selector);
        vault.resolveDispute(true);
    }

    function testCannotResolveDisputeTwiceAfterRefund() public {
        _fundAndDispute();
        vm.prank(payer);
        vault.resolveDispute(false);
        vm.prank(payer);
        vm.expectRevert(ProofFlowVault.NotReady.selector);
        vault.resolveDispute(false);
    }

    function testCompatibilityGettersForEveryState() public {
        _assertCompatibility(vault, ProofFlowVault.VaultState.CREATED, false, false, false);
        _fund();
        _assertCompatibility(vault, ProofFlowVault.VaultState.FUNDED, true, false, false);
        vm.prank(recipient);
        vault.openDispute();
        _assertCompatibility(vault, ProofFlowVault.VaultState.DISPUTED, true, false, true);
        vm.prank(payer);
        vault.resolveDispute(true);
        _assertCompatibility(vault, ProofFlowVault.VaultState.RELEASED, true, true, false);

        ProofFlowVault refundedVault =
            new ProofFlowVault(payer, recipient, 1 ether, uint64(block.timestamp + 1 days), policyHash);
        vm.deal(payer, 1 ether);
        vm.prank(payer);
        refundedVault.fund{value: 1 ether}();
        vm.prank(recipient);
        refundedVault.openDispute();
        vm.prank(payer);
        refundedVault.resolveDispute(false);
        _assertCompatibility(refundedVault, ProofFlowVault.VaultState.REFUNDED, true, false, false);
    }

    function testFuzzUnauthorizedCallerCannotTransition(address caller, uint8 action) public {
        vm.assume(caller != payer && caller != recipient && caller != address(0));
        vm.deal(caller, 2 ether);
        _fund();
        ProofFlowVault.VaultState beforeState = vault.state();
        vm.prank(caller);
        if (action % 7 == 0) address(vault).call{value: 1 ether}("");
        else if (action % 7 == 1) address(vault).call(abi.encodeCall(ProofFlowVault.commitEvidence, (keccak256("x"))));
        else if (action % 7 == 2) address(vault).call(abi.encodeCall(ProofFlowVault.release, ()));
        else if (action % 7 == 3) address(vault).call(abi.encodeCall(ProofFlowVault.openDispute, ()));
        else if (action % 7 == 4) address(vault).call(abi.encodeCall(ProofFlowVault.resolveDispute, (action % 2 == 0)));
        else if (action % 7 == 5) address(vault).call(abi.encodeCall(ProofFlowVault.refundAfterDeadline, ()));
        else address(vault).call(abi.encodeCall(ProofFlowVault.pause, ()));
        assertEq(uint256(vault.state()), uint256(beforeState));
    }

    function testUnauthorizedRefundIsAuthorizationFailure() public {
        address outsider = makeAddr("refund outsider");
        vm.deal(outsider, 1 ether);
        _fund();
        vm.warp(uint256(vault.deadline()) + 1);
        vm.prank(outsider);
        vm.expectRevert(ProofFlowVault.NotReady.selector);
        vault.refundAfterDeadline();
        assertEq(uint256(vault.state()), uint256(ProofFlowVault.VaultState.FUNDED));
    }

    function testUnauthorizedDisputeResolutionBothOutcomes() public {
        address outsider = makeAddr("resolution outsider");
        _fundAndDispute();
        vm.prank(outsider);
        vm.expectRevert(ProofFlowVault.NotReady.selector);
        vault.resolveDispute(true);
        vm.prank(outsider);
        vm.expectRevert(ProofFlowVault.NotReady.selector);
        vault.resolveDispute(false);
        assertEq(uint256(vault.state()), uint256(ProofFlowVault.VaultState.DISPUTED));
    }

    function testFuzzFundingAmountRequiresExactValue(uint96 supplied) public {
        uint256 value = bound(uint256(supplied), 0, 2 ether);
        vm.deal(payer, value);
        vm.prank(payer);
        (bool success,) = address(vault).call{value: value}(abi.encodeCall(ProofFlowVault.fund, ()));
        assertEq(success, value == vault.amount());
        assertEq(
            uint256(vault.state()),
            uint256(value == vault.amount() ? ProofFlowVault.VaultState.FUNDED : ProofFlowVault.VaultState.CREATED)
        );
    }

    function testFuzzEvidenceValues(bytes32 value, bool zeroBranch) public {
        _fund();
        bytes32 evidence = zeroBranch ? bytes32(0) : value == bytes32(0) ? bytes32(uint256(1)) : value;
        vm.prank(recipient);
        (bool success,) = address(vault).call(abi.encodeCall(ProofFlowVault.commitEvidence, (evidence)));
        assertEq(success, !zeroBranch);
        assertEq(vault.evidenceHash(), zeroBranch ? bytes32(0) : evidence);
    }

    function testFuzzRefundTimestampBoundary(uint8 branch) public {
        _fund();
        uint256 timestamp = branch % 3 == 0
            ? uint256(vault.deadline()) - 1
            : branch % 3 == 1 ? uint256(vault.deadline()) : uint256(vault.deadline()) + 1;
        vm.warp(timestamp);
        vm.prank(payer);
        (bool success,) = address(vault).call(abi.encodeCall(ProofFlowVault.refundAfterDeadline, ()));
        assertEq(success, timestamp > vault.deadline());
        assertEq(
            uint256(vault.state()),
            uint256(success ? ProofFlowVault.VaultState.REFUNDED : ProofFlowVault.VaultState.FUNDED)
        );
    }

    function testFuzzForcedEtherNeverChangesReleasePayout(uint96 forcedAmount) public {
        uint256 forced = bound(uint256(forcedAmount), 1, 10 ether);
        _fund();
        ForceSend forceSend = new ForceSend{value: forced}();
        forceSend.destroy(payable(address(vault)));
        vm.prank(recipient);
        vault.commitEvidence(keccak256("evidence"));
        uint256 recipientBefore = recipient.balance;
        vm.prank(payer);
        vault.release();
        assertEq(recipient.balance - recipientBefore, vault.amount());
        assertEq(address(vault).balance, forced);
    }

    function testFuzzBoundedStateTransitionSequences(bytes32 seed) public {
        vm.deal(payer, 20 ether);
        ProofFlowVault.VaultState previous = vault.state();
        for (uint256 index; index < 12; index++) {
            uint8 action = uint8(uint256(keccak256(abi.encode(seed, index))) % 7);
            uint8 actorSeed = uint8(uint256(keccak256(abi.encode("actor", seed, index))) % 3);
            address actor = actorSeed == 0 ? payer : actorSeed == 1 ? recipient : makeAddr("sequence outsider");
            vm.prank(actor);
            if (action == 0) {
                address(vault).call{value: 1 ether}(abi.encodeCall(ProofFlowVault.fund, ()));
            } else if (action == 1) {
                address(vault).call(abi.encodeCall(ProofFlowVault.commitEvidence, (keccak256(abi.encode(seed, index)))));
            } else if (action == 2) {
                address(vault).call(abi.encodeCall(ProofFlowVault.openDispute, ()));
            } else if (action == 3) {
                address(vault).call(abi.encodeCall(ProofFlowVault.release, ()));
            } else if (action == 4) {
                address(vault).call(abi.encodeCall(ProofFlowVault.resolveDispute, (index % 2 == 0)));
            } else if (action == 5) {
                address(vault).call(abi.encodeCall(ProofFlowVault.pause, ()));
            } else {
                address(vault).call(abi.encodeCall(ProofFlowVault.unpause, ()));
            }
            ProofFlowVault.VaultState current = vault.state();
            assertTrue(_isDeclaredTransition(previous, current));
            if (previous == ProofFlowVault.VaultState.RELEASED || previous == ProofFlowVault.VaultState.REFUNDED) {
                assertEq(uint256(current), uint256(previous));
            }
            previous = current;
        }
    }

    function testDisputedStateRejectsNonResolutionOperations() public {
        _fundAndDispute();
        vm.prank(recipient);
        vm.expectRevert(ProofFlowVault.NotReady.selector);
        vault.commitEvidence(keccak256("disputed evidence"));
        vm.prank(payer);
        vm.expectRevert(ProofFlowVault.NotReady.selector);
        vault.release();
        vm.warp(uint256(vault.deadline()) + 1);
        vm.prank(payer);
        vm.expectRevert(ProofFlowVault.NotReady.selector);
        vault.refundAfterDeadline();
        vm.deal(payer, 1 ether);
        vm.prank(payer);
        vm.expectRevert(ProofFlowVault.AlreadyFunded.selector);
        vault.fund{value: 1 ether}();
    }

    function testHandlerReachesAllApprovedLifecycleRoutes() public {
        ProofFlowVaultHandler releaseHandler = new ProofFlowVaultHandler();
        releaseHandler.advance(0);
        assertEq(uint256(releaseHandler.vault().state()), uint256(ProofFlowVault.VaultState.FUNDED));
        releaseHandler.advance(0);
        assertEq(uint256(releaseHandler.vault().state()), uint256(ProofFlowVault.VaultState.DISPUTED));
        releaseHandler.advance(0);
        assertEq(uint256(releaseHandler.vault().state()), uint256(ProofFlowVault.VaultState.RELEASED));

        ProofFlowVaultHandler deadlineRefundHandler = new ProofFlowVaultHandler();
        deadlineRefundHandler.advance(0);
        deadlineRefundHandler.advance(2);
        assertEq(uint256(deadlineRefundHandler.vault().state()), uint256(ProofFlowVault.VaultState.REFUNDED));

        ProofFlowVaultHandler disputeRefundHandler = new ProofFlowVaultHandler();
        disputeRefundHandler.advance(0);
        disputeRefundHandler.advance(0);
        disputeRefundHandler.advance(1);
        assertEq(uint256(disputeRefundHandler.vault().state()), uint256(ProofFlowVault.VaultState.REFUNDED));

        assertGt(releaseHandler.meaningfulTransitions(), 0);
        assertGt(deadlineRefundHandler.meaningfulTransitions(), 0);
        assertGt(disputeRefundHandler.meaningfulTransitions(), 0);
    }

    function _fund() internal {
        vm.prank(payer);
        vault.fund{value: 1 ether}();
    }

    function _fundAndDispute() internal {
        _fund();
        vm.prank(recipient);
        vault.openDispute();
    }

    function _fundCommitAndRelease() internal {
        _fund();
        vm.prank(recipient);
        vault.commitEvidence(keccak256("evidence"));
        vm.prank(payer);
        vault.release();
    }

    function _assertCompatibility(
        ProofFlowVault target,
        ProofFlowVault.VaultState expectedState,
        bool expectedFunded,
        bool expectedReleased,
        bool expectedDisputed
    ) internal view {
        assertEq(uint256(target.state()), uint256(expectedState));
        assertEq(target.funded(), expectedFunded);
        assertEq(target.released(), expectedReleased);
        assertEq(target.disputed(), expectedDisputed);
    }

    function _isDeclaredTransition(ProofFlowVault.VaultState from, ProofFlowVault.VaultState to)
        internal
        pure
        returns (bool)
    {
        if (from == to) return true;
        if (from == ProofFlowVault.VaultState.CREATED) return to == ProofFlowVault.VaultState.FUNDED;
        if (from == ProofFlowVault.VaultState.FUNDED) {
            return to == ProofFlowVault.VaultState.DISPUTED || to == ProofFlowVault.VaultState.RELEASED
                || to == ProofFlowVault.VaultState.REFUNDED;
        }
        if (from == ProofFlowVault.VaultState.DISPUTED) {
            return to == ProofFlowVault.VaultState.RELEASED || to == ProofFlowVault.VaultState.REFUNDED;
        }
        return false;
    }
}

contract ProofFlowVaultHandler is Test {
    ProofFlowVault public vault;
    ProofFlowVault public failedReleaseVault;
    ProofFlowVault public failedDisputeReleaseVault;
    RejectingPayer public rejectingPayer;
    ProofFlowVault public failedRefundVault;

    address public payer = address(0xA11CE);
    address public recipient = address(0xB0B);
    address public outsider = address(0xBAD);
    uint256 public constant AMOUNT = 1 ether;
    uint256 public constant INITIAL_PAYER_BALANCE = 100 ether;
    uint256 public constant FIXTURE_RESERVED_BALANCE = 2 ether;

    bool public invalidTransitionObserved;
    bool public terminalTransitionObserved;
    bool public unauthorizedTransitionObserved;
    bool public failedTransferRollbackViolation;
    uint256 public releaseSettlements;
    uint256 public refundSettlements;
    uint256 public forcedTotal;
    uint256 public meaningfulTransitions;
    uint256 public createdReached;
    uint256 public fundedReached;
    uint256 public disputedReached;
    uint256 public releasedReached;
    uint256 public refundedReached;

    constructor() {
        bytes32 policy = keccak256("invariant-policy");
        uint64 deadline = uint64(block.timestamp + 30 days);
        vm.deal(payer, INITIAL_PAYER_BALANCE);
        vault = new ProofFlowVault(payer, recipient, AMOUNT, deadline, policy);

        RejectingReceiver rejectingRecipient = new RejectingReceiver();
        failedReleaseVault = new ProofFlowVault(payer, address(rejectingRecipient), AMOUNT, deadline, policy);
        vm.prank(payer);
        failedReleaseVault.fund{value: AMOUNT}();
        vm.prank(payer);
        failedReleaseVault.commitEvidence(keccak256("failed release evidence"));

        failedDisputeReleaseVault = new ProofFlowVault(payer, address(rejectingRecipient), AMOUNT, deadline, policy);
        vm.prank(payer);
        failedDisputeReleaseVault.fund{value: AMOUNT}();
        vm.prank(payer);
        failedDisputeReleaseVault.openDispute();

        rejectingPayer = new RejectingPayer();
        vm.deal(address(rejectingPayer), AMOUNT);
        failedRefundVault = new ProofFlowVault(address(rejectingPayer), recipient, AMOUNT, deadline, policy);
        rejectingPayer.setVault(failedRefundVault);
        rejectingPayer.fundVault(AMOUNT);
        rejectingPayer.openDispute();
    }

    function fund(uint96 supplied, bool receivePath, uint8 actorSeed) external {
        uint256 branch = uint256(supplied) % 4;
        uint256 value = branch == 0
            ? AMOUNT
            : branch == 1 ? AMOUNT - 1 : branch == 2 ? AMOUNT + 1 : bound(uint256(supplied), 0, 2 ether);
        address actor = _actor(actorSeed);
        ProofFlowVault.VaultState beforeState = vault.state();
        vm.prank(actor);
        if (receivePath) {
            (bool success,) = address(vault).call{value: value}("");
            success;
        } else {
            (bool success,) = address(vault).call{value: value}(abi.encodeCall(ProofFlowVault.fund, ()));
            success;
        }
        _observe(beforeState, actor);
    }

    function advance(uint8 route) external {
        ProofFlowVault.VaultState beforeState = vault.state();
        if (beforeState == ProofFlowVault.VaultState.CREATED) {
            vm.prank(payer);
            vault.fund{value: AMOUNT}();
        } else if (beforeState == ProofFlowVault.VaultState.FUNDED) {
            uint8 choice = route % 5;
            if (choice == 0) {
                vm.prank(recipient);
                vault.openDispute();
            } else if (choice == 1) {
                vm.prank(recipient);
                vault.commitEvidence(keccak256(abi.encode(route)));
                vm.prank(payer);
                vault.release();
            } else if (choice == 2) {
                vm.warp(uint256(vault.deadline()) + 1);
                vm.prank(payer);
                vault.refundAfterDeadline();
            } else if (choice == 3) {
                vm.prank(recipient);
                vault.commitEvidence(keccak256(abi.encode(route)));
                forceEther(1);
                vm.prank(payer);
                vault.release();
            } else {
                vm.prank(payer);
                vault.commitEvidence(keccak256(abi.encode(route)));
            }
        } else if (beforeState == ProofFlowVault.VaultState.DISPUTED) {
            if (route % 2 == 0) {
                vm.prank(payer);
                vault.resolveDispute(true);
            } else {
                vm.prank(payer);
                vault.resolveDispute(false);
            }
        }
        _observe(beforeState, payer);
    }

    function pauseAndProbe(uint8 route) external {
        vm.prank(payer);
        vault.pause();
        vm.prank(payer);
        address(vault).call{value: AMOUNT}("");
        vm.prank(payer);
        address(vault).call(abi.encodeCall(ProofFlowVault.commitEvidence, (keccak256("paused"))));
        vm.prank(recipient);
        address(vault).call(abi.encodeCall(ProofFlowVault.openDispute, ()));
        vm.prank(payer);
        address(vault).call(abi.encodeCall(ProofFlowVault.resolveDispute, (route % 2 == 0)));
        vm.prank(payer);
        address(vault).call(abi.encodeCall(ProofFlowVault.refundAfterDeadline, ()));
        vm.prank(payer);
        vault.unpause();
    }

    function commitEvidence(bytes32 evidence, uint8 actorSeed) external {
        address actor = _actor(actorSeed);
        ProofFlowVault.VaultState beforeState = vault.state();
        vm.prank(actor);
        (bool success,) = address(vault).call(abi.encodeCall(ProofFlowVault.commitEvidence, (evidence)));
        success;
        _observe(beforeState, actor);
    }

    function openDispute(uint8 actorSeed) external {
        address actor = _actor(actorSeed);
        ProofFlowVault.VaultState beforeState = vault.state();
        vm.prank(actor);
        (bool success,) = address(vault).call(abi.encodeCall(ProofFlowVault.openDispute, ()));
        success;
        _observe(beforeState, actor);
    }

    function release(uint8 actorSeed) external {
        address actor = _actor(actorSeed);
        ProofFlowVault.VaultState beforeState = vault.state();
        vm.prank(actor);
        (bool success,) = address(vault).call(abi.encodeCall(ProofFlowVault.release, ()));
        success;
        _observe(beforeState, actor);
    }

    function resolveDispute(bool releaseFunds, uint8 actorSeed) external {
        address actor = _actor(actorSeed);
        ProofFlowVault.VaultState beforeState = vault.state();
        vm.prank(actor);
        (bool success,) = address(vault).call(abi.encodeCall(ProofFlowVault.resolveDispute, (releaseFunds)));
        success;
        _observe(beforeState, actor);
    }

    function refundAfterDeadline(bool afterDeadline, uint8 actorSeed) external {
        address actor = _actor(actorSeed);
        vm.warp(afterDeadline ? uint256(vault.deadline()) + 1 : uint256(vault.deadline()));
        ProofFlowVault.VaultState beforeState = vault.state();
        vm.prank(actor);
        (bool success,) = address(vault).call(abi.encodeCall(ProofFlowVault.refundAfterDeadline, ()));
        success;
        _observe(beforeState, actor);
    }

    function forceEther(uint96 rawAmount) public {
        uint256 forced = bound(uint256(rawAmount), 1, 2 ether);
        vm.deal(address(this), forced);
        ForceSend forceSend = new ForceSend{value: forced}();
        forceSend.destroy(payable(address(vault)));
        forcedTotal += forced;
    }

    function attemptFailedRelease() external {
        ProofFlowVault.VaultState beforeState = failedReleaseVault.state();
        uint256 beforeBalance = address(failedReleaseVault).balance;
        vm.prank(payer);
        (bool success,) = address(failedReleaseVault).call(abi.encodeCall(ProofFlowVault.release, ()));
        if (
            success || failedReleaseVault.state() != beforeState || address(failedReleaseVault).balance != beforeBalance
        ) {
            failedTransferRollbackViolation = true;
        }
    }

    function attemptFailedDisputeRelease() external {
        ProofFlowVault.VaultState beforeState = failedDisputeReleaseVault.state();
        uint256 beforeBalance = address(failedDisputeReleaseVault).balance;
        vm.prank(payer);
        (bool success,) = address(failedDisputeReleaseVault).call(abi.encodeCall(ProofFlowVault.resolveDispute, (true)));
        if (
            success || failedDisputeReleaseVault.state() != beforeState
                || address(failedDisputeReleaseVault).balance != beforeBalance
        ) failedTransferRollbackViolation = true;
    }

    function attemptFailedDisputeRefund() external {
        ProofFlowVault.VaultState beforeState = failedRefundVault.state();
        uint256 beforeBalance = address(failedRefundVault).balance;
        (bool success,) = address(rejectingPayer).call(abi.encodeCall(RejectingPayer.resolveRefund, ()));
        if (success || failedRefundVault.state() != beforeState || address(failedRefundVault).balance != beforeBalance)
        {
            failedTransferRollbackViolation = true;
        }
    }

    function _observe(ProofFlowVault.VaultState beforeState, address actor) internal {
        ProofFlowVault.VaultState afterState = vault.state();
        if (afterState != beforeState) meaningfulTransitions++;
        if (afterState == ProofFlowVault.VaultState.CREATED) createdReached++;
        if (afterState == ProofFlowVault.VaultState.FUNDED) fundedReached++;
        if (afterState == ProofFlowVault.VaultState.DISPUTED) disputedReached++;
        if (afterState == ProofFlowVault.VaultState.RELEASED) releasedReached++;
        if (afterState == ProofFlowVault.VaultState.REFUNDED) refundedReached++;
        if (!_isDeclaredTransition(beforeState, afterState)) invalidTransitionObserved = true;
        if (
            (beforeState == ProofFlowVault.VaultState.RELEASED || beforeState == ProofFlowVault.VaultState.REFUNDED)
                && afterState != beforeState
        ) terminalTransitionObserved = true;
        if (actor == outsider && afterState != beforeState) unauthorizedTransitionObserved = true;
        if (beforeState != ProofFlowVault.VaultState.RELEASED && afterState == ProofFlowVault.VaultState.RELEASED) {
            releaseSettlements++;
        }
        if (beforeState != ProofFlowVault.VaultState.REFUNDED && afterState == ProofFlowVault.VaultState.REFUNDED) {
            refundSettlements++;
        }
    }

    function _actor(uint8 seed) internal view returns (address) {
        if (seed % 3 == 0) return payer;
        if (seed % 3 == 1) return recipient;
        return outsider;
    }

    function _isDeclaredTransition(ProofFlowVault.VaultState from, ProofFlowVault.VaultState to)
        internal
        pure
        returns (bool)
    {
        if (from == to) return true;
        if (from == ProofFlowVault.VaultState.CREATED) return to == ProofFlowVault.VaultState.FUNDED;
        if (from == ProofFlowVault.VaultState.FUNDED) {
            return to == ProofFlowVault.VaultState.DISPUTED || to == ProofFlowVault.VaultState.RELEASED
                || to == ProofFlowVault.VaultState.REFUNDED;
        }
        if (from == ProofFlowVault.VaultState.DISPUTED) {
            return to == ProofFlowVault.VaultState.RELEASED || to == ProofFlowVault.VaultState.REFUNDED;
        }
        return false;
    }
}

contract ProofFlowVaultInvariantTest is StdInvariant, Test {
    ProofFlowVaultHandler handler;
    ProofFlowVault vault;

    function setUp() public {
        handler = new ProofFlowVaultHandler();
        vault = handler.vault();
        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = handler.fund.selector;
        selectors[1] = handler.commitEvidence.selector;
        selectors[2] = handler.openDispute.selector;
        selectors[3] = handler.release.selector;
        selectors[4] = handler.resolveDispute.selector;
        selectors[5] = handler.refundAfterDeadline.selector;
        selectors[6] = handler.forceEther.selector;
        selectors[7] = handler.attemptFailedRelease.selector;
        selectors[8] = handler.attemptFailedDisputeRelease.selector;
        selectors[9] = handler.attemptFailedDisputeRefund.selector;
        selectors = _appendSelector(selectors, handler.advance.selector);
        selectors = _appendSelector(selectors, handler.pauseAndProbe.selector);
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariantStateBelongsToDeclaredEnum() public view {
        assertLe(uint256(vault.state()), uint256(ProofFlowVault.VaultState.REFUNDED));
    }

    function invariantOnlyDeclaredTransitionsOccur() public view {
        assertFalse(handler.invalidTransitionObserved());
    }

    function invariantReleasedAndRefundedAreTerminal() public view {
        assertFalse(handler.terminalTransitionObserved());
    }

    function invariantUnauthorizedCallersCannotTransitionLifecycle() public view {
        assertFalse(handler.unauthorizedTransitionObserved());
    }

    function invariantSettlementOccursAtMostOnce() public view {
        assertLe(handler.releaseSettlements() + handler.refundSettlements(), 1);
    }

    function invariantPayoutsUseOnlyContractualAmountAndParticipants() public view {
        ProofFlowVault.VaultState current = vault.state();
        uint256 payerExpected = handler.INITIAL_PAYER_BALANCE() - handler.FIXTURE_RESERVED_BALANCE();
        uint256 recipientExpected;
        if (current == ProofFlowVault.VaultState.FUNDED || current == ProofFlowVault.VaultState.DISPUTED) {
            payerExpected -= handler.AMOUNT();
        } else if (current == ProofFlowVault.VaultState.RELEASED) {
            payerExpected -= handler.AMOUNT();
            recipientExpected = handler.AMOUNT();
        }
        assertEq(handler.payer().balance, payerExpected);
        assertEq(handler.recipient().balance, recipientExpected);
    }

    function invariantForcedEtherDoesNotChangeContractualPayout() public view {
        ProofFlowVault.VaultState current = vault.state();
        uint256 expectedBalance = handler.forcedTotal();
        if (current == ProofFlowVault.VaultState.FUNDED || current == ProofFlowVault.VaultState.DISPUTED) {
            expectedBalance += handler.AMOUNT();
        }
        assertEq(address(vault).balance, expectedBalance);
    }

    function invariantFailedTransfersRollbackLifecycleState() public view {
        assertFalse(handler.failedTransferRollbackViolation());
        assertEq(uint256(handler.failedReleaseVault().state()), uint256(ProofFlowVault.VaultState.FUNDED));
        assertEq(uint256(handler.failedDisputeReleaseVault().state()), uint256(ProofFlowVault.VaultState.DISPUTED));
        assertEq(uint256(handler.failedRefundVault().state()), uint256(ProofFlowVault.VaultState.DISPUTED));
    }

    function invariantCompatibilityGettersMatchState() public view {
        ProofFlowVault.VaultState current = vault.state();
        assertEq(vault.funded(), current != ProofFlowVault.VaultState.CREATED);
        assertEq(vault.released(), current == ProofFlowVault.VaultState.RELEASED);
        assertEq(vault.disputed(), current == ProofFlowVault.VaultState.DISPUTED);
    }

    function _appendSelector(bytes4[] memory selectors, bytes4 selector)
        internal
        pure
        returns (bytes4[] memory expanded)
    {
        expanded = new bytes4[](selectors.length + 1);
        for (uint256 index; index < selectors.length; index++) {
            expanded[index] = selectors[index];
        }
        expanded[selectors.length] = selector;
    }
}
