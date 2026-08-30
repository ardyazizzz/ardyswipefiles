$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'load-env.ps1')

$headers = @{
  Authorization = "Bearer $env:SWIPEARDY_CODEX_TOKEN"
  Accept = 'application/json, text/event-stream'
  'MCP-Protocol-Version' = '2025-06-18'
}

function Invoke-McpRequest([int]$id, [string]$method, [hashtable]$params) {
  $body = @{
    jsonrpc = '2.0'
    id = $id
    method = $method
    params = $params
  } | ConvertTo-Json -Depth 12 -Compress

  Invoke-RestMethod -Uri $env:SWIPEARDY_MCP_URL -Method Post -Headers $headers `
    -ContentType 'application/json' -Body $body
}

$initialize = Invoke-McpRequest 1 'initialize' @{
  protocolVersion = '2025-06-18'
  capabilities = @{}
  clientInfo = @{ name = 'swipeardy-smoke-test'; version = '1.0' }
}

# Streamable HTTP servers may return an empty response for this notification;
# the request is still part of the standard MCP initialization sequence.
$null = Invoke-McpRequest 2 'notifications/initialized' @{}
$toolsResult = Invoke-McpRequest 3 'tools/list' @{}
$statusResult = Invoke-McpRequest 4 'tools/call' @{ name = 'status'; arguments = @{} }
$searchResult = Invoke-McpRequest 5 'tools/call' @{ name = 'search_posts'; arguments = @{ mode = 'posts'; limit = 1; offset = 0 } }

$expectedTools = @(
  'status', 'search_posts', 'get_post', 'get_post_image', 'create_post',
  'scan_image_health', 'repair_post_images', 'bulk_repair_post_images', 'update_post', 'delete_posts', 'list_trash', 'restore_post', 'export_posts',
  'curate_posts', 'list_filters', 'update_filter_config', 'list_views'
)
$advertisedTools = @($toolsResult.result.tools | ForEach-Object { $_.name })
$missingTools = @($expectedTools | Where-Object { $_ -notin $advertisedTools })
if ($missingTools.Count -gt 0) {
  throw "Gateway is missing expected MCP tools: $($missingTools -join ', ')"
}

function Get-StructuredContent($result) {
  if ($null -ne $result.result.structuredContent) { return $result.result.structuredContent }
  $textBlock = @($result.result.content | Where-Object { $_.type -eq 'text' }) | Select-Object -First 1
  if ($null -eq $textBlock) { throw 'MCP result did not include structured content or a text block.' }
  return ($textBlock.text | ConvertFrom-Json)
}

$status = Get-StructuredContent $statusResult
$search = Get-StructuredContent $searchResult
$firstPost = @($search.records | Select-Object -First 1)[0]
if ($null -eq $firstPost -or $null -eq $firstPost.id) {
  throw 'Gateway search returned no post to use for the read-only image-health smoke check.'
}
$imageHealthResult = Invoke-McpRequest 6 'tools/call' @{ name = 'scan_image_health'; arguments = @{ post_ids = @([int64]$firstPost.id); max_images_per_post = 1 } }
$imageHealth = Get-StructuredContent $imageHealthResult
$searchCount = if ($null -ne $search.count) {
  $search.count
} elseif ($null -ne $search.page.returned) {
  $search.page.returned
} elseif ($null -ne $search.records) {
  @($search.records).Count
} else {
  @($search.posts).Count
}

[pscustomobject]@{
  protocol = $initialize.result.protocolVersion
  server = $initialize.result.serverInfo.name
  tool_count = $advertisedTools.Count
  missing_tools = if ($missingTools.Count) { $missingTools -join ', ' } else { '(none)' }
  agent = $status.agent.name
  scopes = ($status.agent.scopes -join ', ')
  post_count = $status.counts.posts
  search_mode = $search.mode
  search_count = $searchCount
  image_health_post_id = $firstPost.id
  image_health_status = @($imageHealth.records | Select-Object -First 1).status
  region = $status.region
  writes_performed = $false
} | Format-List

