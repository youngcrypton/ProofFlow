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

    enum VaultState {
        CREATED,
        FUNDED,
        DISPUTED,
        RELEASED,
        REFUNDED
    }

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
    VaultState public state;
    bool public paused;

    function funded() public view returns (bool) {
        return state != VaultState.CREATED;
    }

    function released() public view returns (bool) {
        return state == VaultState.RELEASED;
    }

    function disputed() public view returns (bool) {
        return state == VaultState.DISPUTED;
    }

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
        state = VaultState.CREATED;
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
        if (state != VaultState.FUNDED) revert NotReady();
        if (evidenceHash_ == bytes32(0)) revert InvalidAmount();
        evidenceHash = evidenceHash_;
        emit EvidenceCommitted(evidenceHash_);
    }

    function release() external nonReentrant {
        if (paused) revert VaultPaused();
        if (msg.sender != payer) revert NotPayer();
        if (state != VaultState.FUNDED || evidenceHash == bytes32(0)) revert NotReady();
        state = VaultState.RELEASED;
        (bool success,) = payable(recipient).call{value: amount}("");
        if (!success) revert TransferFailed();
        emit Released(recipient, amount);
    }

    function openDispute() external {
        if (paused) revert VaultPaused();
        if (msg.sender != payer && msg.sender != recipient) revert NotReady();
        if (state != VaultState.FUNDED) revert NotReady();
        state = VaultState.DISPUTED;
        emit DisputeOpened(msg.sender);
    }

    function resolveDispute(bool releaseFunds) external nonReentrant {
        if (paused) revert VaultPaused();
        if (msg.sender != payer || state != VaultState.DISPUTED) revert NotReady();
        if (releaseFunds) {
            state = VaultState.RELEASED;
            (bool success,) = payable(recipient).call{value: amount}("");
            if (!success) revert TransferFailed();
            emit Released(recipient, amount);
        } else {
            state = VaultState.REFUNDED;
            (bool success,) = payable(payer).call{value: amount}("");
            if (!success) revert TransferFailed();
            emit Refunded(payer, amount);
        }
        emit DisputeResolved(releaseFunds);
    }

    function refundAfterDeadline() external nonReentrant {
        if (paused) revert VaultPaused();
        if (msg.sender != payer || state != VaultState.FUNDED || block.timestamp <= deadline) revert NotReady();
        state = VaultState.REFUNDED;
        (bool success,) = payable(payer).call{value: amount}("");
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
        if (state != VaultState.CREATED) revert AlreadyFunded();
        if (msg.value != amount) revert InvalidAmount();
        state = VaultState.FUNDED;
        emit Funded(msg.sender, msg.value);
    }
}
