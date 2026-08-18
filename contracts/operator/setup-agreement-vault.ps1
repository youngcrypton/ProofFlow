[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$AgreementId,
  [string]$ApiBaseUrl = "https://proofflowapi-production-49be.up.railway.app",
  [string]$RpcUrl = "https://testrpc.xlayer.tech/terigon",
  [switch]$Broadcast,
  [switch]$Associate
)

$ErrorActionPreference = "Stop"

if ($Broadcast -or $Associate) {
  throw "This helper is currently dry-run only. Review the output, then perform broadcast and association through the documented operator workflow."
}

if (-not $env:PROOFFLOW_API_TOKEN) { throw "PROOFFLOW_API_TOKEN is required in the local environment." }
if (-not $env:PROOFFLOW_DEPLOYER_PRIVATE_KEY) { throw "PROOFFLOW_DEPLOYER_PRIVATE_KEY is required in the local environment for Foundry simulation." }

$headers = @{ Authorization = "Bearer $($env:PROOFFLOW_API_TOKEN)"; Accept = "application/json" }
$agreementResponse = Invoke-RestMethod -Method Get -Uri "$($ApiBaseUrl.TrimEnd('/'))/api/v1/operator/agreements/$([uri]::EscapeDataString($AgreementId))" -Headers $headers
$agreement = $agreementResponse.data
if (-not $agreement) { throw "Agreement '$AgreementId' was not found in the production API response." }
if ($agreement.state -ne "AWAITING_FUNDING") { throw "Agreement state is '$($agreement.state)'; expected AWAITING_FUNDING." }
if ($agreement.vaultAddress) { throw "Agreement already has a vaultAddress; refusing to deploy or associate another vault." }

$chainId = (& cast chain-id --rpc-url $RpcUrl).Trim()
if ($LASTEXITCODE -ne 0 -or $chainId -ne "1952") { throw "Expected X Layer testnet chain ID 1952, received '$chainId'." }

$env:XLAYER_RPC_URL = $RpcUrl
$env:PROOFFLOW_PAYER = $agreement.payer
$env:PROOFFLOW_RECIPIENT = $agreement.recipient
$env:PROOFFLOW_AMOUNT_BASE_UNITS = $agreement.amountBaseUnits
$env:PROOFFLOW_DEADLINE_UNIX = ([DateTimeOffset]::Parse($agreement.deadline)).ToUnixTimeSeconds().ToString()
$env:PROOFFLOW_POLICY_HASH = $agreement.policyHash

Write-Host "Agreement: $($agreement.id)"
Write-Host "State: $($agreement.state)"
Write-Host "Chain ID: $chainId"
Write-Host "Payer: $($agreement.payer)"
Write-Host "Recipient: $($agreement.recipient)"
Write-Host "Amount base units: $($agreement.amountBaseUnits)"
Write-Host "Deadline: $($agreement.deadline)"
Write-Host "Policy hash: $($agreement.policyHash)"
Write-Host "Dry-run: running existing DeployProofFlowVault.s.sol without broadcast"

Push-Location (Join-Path $PSScriptRoot "..")
try {
  & forge script script/DeployProofFlowVault.s.sol --rpc-url $RpcUrl
  if ($LASTEXITCODE -ne 0) { throw "Foundry dry-run failed." }
} finally {
  Pop-Location
}

Write-Host "Dry-run complete. No contract was broadcast and no vault was associated."
