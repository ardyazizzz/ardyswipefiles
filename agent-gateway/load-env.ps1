$ErrorActionPreference = 'Stop'

$envFile = Join-Path $PSScriptRoot '.env.local'
if (Test-Path -LiteralPath $envFile) {
  Get-Content -LiteralPath $envFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) { return }
    $parts = $line.Split('=', 2)
    if ($parts.Count -ne 2) { return }
    [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), 'Process')
  }
}

# The endpoint is public configuration; default it so the smoke test works
# immediately after checkout. The token must come from a local secret source.
if ([string]::IsNullOrWhiteSpace($env:SWIPEARDY_MCP_URL)) {
  $env:SWIPEARDY_MCP_URL = 'https://dmhiitzunsdqyxopqsby.supabase.co/functions/v1/swipe-ardy-agent/mcp'
}
if ([string]::IsNullOrWhiteSpace($env:SWIPEARDY_REST_URL)) {
  $env:SWIPEARDY_REST_URL = 'https://dmhiitzunsdqyxopqsby.supabase.co/functions/v1/swipe-ardy-agent/api/v1'
}

# Environment variables stored at User scope are copied into this process when
# a .env.local value was not supplied. Never print the token value.
if ([string]::IsNullOrWhiteSpace($env:SWIPEARDY_CODEX_TOKEN)) {
  $userToken = [Environment]::GetEnvironmentVariable('SWIPEARDY_CODEX_TOKEN', 'User')
  if (-not [string]::IsNullOrWhiteSpace($userToken)) { $env:SWIPEARDY_CODEX_TOKEN = $userToken }
}

if ([string]::IsNullOrWhiteSpace($env:SWIPEARDY_CODEX_TOKEN)) {
  throw 'Missing SWIPEARDY_CODEX_TOKEN. Set it in agent-gateway/.env.local or your user environment.'
}

Write-Host 'Swipe Ardy agent environment loaded for this PowerShell process.'

