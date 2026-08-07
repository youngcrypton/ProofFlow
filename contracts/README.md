# ProofFlow contracts

`ProofFlowVault` is the local custody boundary for the MVP. It accepts exactly one native-token deposit from the configured payer, requires an evidence commitment, and permits one release to the immutable recipient. Disputes, refunds, pause, and reentrancy protection are explicit.

The contract is intentionally not connected to AI. AI output must be reduced to a reviewed, deterministic settlement intent before an authorized signer calls the contract.

## Local verification

Requires Foundry:

```bash
forge install OpenZeppelin/openzeppelin-contracts --no-commit
forge install foundry-rs/forge-std --no-commit
forge test
```

Do not deploy this contract to mainnet or use real funds before an independent audit.
