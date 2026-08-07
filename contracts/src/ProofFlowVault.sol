// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract ProofFlowVault is ReentrancyGuard {
    error AlreadyFunded();
    error AlreadyReleased();
    error InvalidAmount();
    error InvalidDeadline();
    error InvalidRecipient();
    error NotPayer();
    error NotReady();
    error VaultPaused();
    error TransferFailed();

    struct Agreement {
        address payer;
        address recipient;
        uint256 amount;
        uint64 deadline;
        bytes32 policyHash;
        bytes32 evidenceHash;
        bool funded;
        bool released;
        bool disputed;
    }

    address public immutable payer;
    address public immutable recipient;
    uint256 public immutable amount;
    uint64 public immutable deadline;
    bytes32 public immutable policyHash;
    bytes32 public evidenceHash;
    bool public funded;
    bool public released;
    bool public disputed;
    bool public paused;

    event Funded(address indexed payer, uint256 amount);
    event EvidenceCommitted(bytes32 indexed evidenceHash);
    event DisputeOpened(address indexed opener);
    event DisputeResolved(bool released);
    event Released(address indexed recipient, uint256 amount);
    event Refunded(address indexed payer, uint256 amount);
    event PausedStateChanged(address indexed account, bool paused);
    event Unpaused(address indexed account);

    constructor(address payer_, address recipient_, uint256 amount_, uint64 deadline_, bytes32 policyHash_) {
        if (payer_ == address(0) || recipient_ == address(0)) revert InvalidRecipient();
        if (amount_ == 0) revert InvalidAmount();
        if (deadline_ <= block.timestamp) revert InvalidDeadline();
        payer = payer_;
        recipient = recipient_;
        amount = amount_;
        deadline = deadline_;
        policyHash = policyHash_;
    }

    receive() external payable {
        _fund();
    }

    function fund() external payable nonReentrant {
        _fund();
    }

    function commitEvidence(bytes32 evidenceHash_) external {
        if (paused) revert VaultPaused();
        if (msg.sender != payer && msg.sender != recipient) revert NotReady();
        if (!funded || released || disputed) revert NotReady();
        if (evidenceHash_ == bytes32(0)) revert InvalidAmount();
        evidenceHash = evidenceHash_;
        emit EvidenceCommitted(evidenceHash_);
    }

    function release() external nonReentrant {
        if (paused) revert VaultPaused();
        if (msg.sender != payer) revert NotPayer();
        if (!funded || released || disputed || evidenceHash == bytes32(0)) revert NotReady();
        released = true;
        (bool success,) = payable(recipient).call{value: address(this).balance}('');
        if (!success) revert TransferFailed();
        emit Released(recipient, amount);
    }

    function openDispute() external {
        if (paused) revert VaultPaused();
        if (msg.sender != payer && msg.sender != recipient) revert NotReady();
        if (!funded || released || disputed) revert NotReady();
        disputed = true;
        emit DisputeOpened(msg.sender);
    }

    function resolveDispute(bool releaseFunds) external nonReentrant {
        if (paused) revert VaultPaused();
        if (msg.sender != payer || !disputed || released) revert NotReady();
        disputed = false;
        if (releaseFunds) {
            released = true;
            (bool success,) = payable(recipient).call{value: address(this).balance}('');
            if (!success) revert TransferFailed();
            emit Released(recipient, amount);
        } else {
            (bool success,) = payable(payer).call{value: address(this).balance}('');
            if (!success) revert TransferFailed();
            emit Refunded(payer, amount);
        }
        emit DisputeResolved(releaseFunds);
    }

    function refundAfterDeadline() external nonReentrant {
        if (paused) revert VaultPaused();
        if (msg.sender != payer || !funded || released || disputed || block.timestamp <= deadline) revert NotReady();
        released = true;
        (bool success,) = payable(payer).call{value: address(this).balance}('');
        if (!success) revert TransferFailed();
        emit Refunded(payer, amount);
    }

    function pause() external {
        if (msg.sender != payer) revert NotPayer();
        paused = true;
        emit PausedStateChanged(msg.sender, true);
    }

    function unpause() external {
        if (msg.sender != payer) revert NotPayer();
        paused = false;
        emit PausedStateChanged(msg.sender, false);
    }

    function _fund() internal {
        if (paused) revert VaultPaused();
        if (msg.sender != payer) revert NotPayer();
        if (funded) revert AlreadyFunded();
        if (msg.value != amount) revert InvalidAmount();
        funded = true;
        emit Funded(msg.sender, msg.value);
    }
}
