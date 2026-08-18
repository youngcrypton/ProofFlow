# X Layer deployment procedure

The deployment script is deliberately fail-closed. It only permits X Layer testnet (`1952`), requires explicit constructor inputs, and reads the deployer key only from the process environment.

## Historical demo deployment

This deployment predates agreement-specific vault persistence. It is retained only as a testnet execution record and must never be assigned automatically to an agreement.

- Network: X Layer Testnet, chain ID `1952`
- RPC: `https://testrpc.xlayer.tech/terigon`
- Historical demo vault: `0xF2E246BB76DF876Cef8b38ae84130F4F55De395b`
- Deployment transaction: `0x8eea11c542de65c5d3fe95679a5f09b29ad7c083cc26a3315c3612f1c7e1e5bf`
- Funding transaction: `0x66b05a6cf4a9301dcf762a07d0670db43d602f473c3664ec1d6acfb6a19ce336`
- Evidence transaction: `0x4dd30683f69834a542ae2fb1dce33500e8097abf6a6b675c5784eb97c6da92e1`
- Release transaction: `0xb3e2e063b0921aeb728f643e287f50d6c839875576bee4c832391636f3e6dd99`
- Verified path: deploy → fund `0.001` native token → commit evidence → release
- Final state: `released=true`, vault balance `0`, recipient received `0.001` native token

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

7. Record the deployed address and transaction hash in a deployment artifact outside secrets. An authenticated operator may then associate the address with exactly one agreement; the API verifies every immutable before persisting it.

Never deploy to mainnet from this procedure. Mainnet requires a separate release review, independent contract review, and an explicit approval.
