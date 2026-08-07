# X Layer deployment procedure

The deployment script is deliberately fail-closed. It only permits X Layer testnet (`1952`) or mainnet (`196`), requires explicit constructor inputs, and reads the deployer key only from the process environment.

## Testnet only

1. Create a dedicated deployer wallet. Never reuse a personal wallet.
2. Add a small amount of X Layer testnet OKB from the official faucet.
3. Set environment variables in your shell, never in Git:

```powershell
$env:XLAYER_RPC_URL="https://testrpc.xlayer.tech/terigon"
$env:PROOFFLOW_PAYER="0x..."
$env:PROOFFLOW_RECIPIENT="0x..."
$env:PROOFFLOW_AMOUNT_BASE_UNITS="1000000000000000"
$env:PROOFFLOW_DEADLINE_UNIX="<future-unix-seconds>"
$env:PROOFFLOW_POLICY_HASH="0x..."
$env:PROOFFLOW_DEPLOYER_PRIVATE_KEY="<dedicated-testnet-key>"
```

4. Verify the RPC before deployment:

```powershell
cast chain-id --rpc-url $env:XLAYER_RPC_URL
```

It must return `1952`.

5. Deploy without broadcasting first:

```powershell
forge script script/DeployProofFlowVault.s.sol --rpc-url $env:XLAYER_RPC_URL
```

6. Review the printed constructor values. Only then broadcast:

```powershell
forge script script/DeployProofFlowVault.s.sol --rpc-url $env:XLAYER_RPC_URL --broadcast
```

7. Record the deployed address and transaction hash in a deployment artifact outside secrets. Verify the contract source through OKLink before using it from the API.

Never deploy to mainnet from this procedure. Mainnet requires a separate release review, independent contract review, and an explicit approval.
