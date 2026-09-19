# Publish the SlicerWeb test site at https://slicerweb.slicercloud.app through a Cloudflare tunnel,
# restricted by Cloudflare Access to radixlabmedical.com email addresses.
#
# Requirements:
#  - $env:CLOUDFLARE_API_TOKEN: API token with the "Access: Apps and Policies - Edit" account permission
#  - the production build served locally: cd web; npx vite preview --port 4173
#  - tunnel "slicerweb-test" and its DNS record (created with D:\SlicerWeb-build\tools\cloudflared.exe)
#
# The tunnel is started only after Access protection of the hostname has been verified.
param(
  [string]$Hostname = "slicerweb.slicercloud.app",
  [string]$EmailDomain = "radixlabmedical.com",
  [string]$AccountId = "b9f7eb90f54d22d3d26f72422cac19a1",
  [string]$Cloudflared = "D:\SlicerWeb-build\tools\cloudflared.exe",
  [string]$TunnelConfig = "D:\SlicerWeb-build\tunnel\config.yml"
)
$ErrorActionPreference = "Stop"

if (-not $env:CLOUDFLARE_API_TOKEN) { throw "Set CLOUDFLARE_API_TOKEN (Access: Apps and Policies - Edit)" }
$headers = @{ Authorization = "Bearer $($env:CLOUDFLARE_API_TOKEN)"; "Content-Type" = "application/json" }
$api = "https://api.cloudflare.com/client/v4/accounts/$AccountId/access/apps"

$app = @{
  name = "SlicerWeb test site"
  domain = $Hostname
  type = "self_hosted"
  session_duration = "24h"
  app_launcher_visible = $false
  policies = @(@{
    name = "Allow $EmailDomain"
    decision = "allow"
    include = @(@{ email_domain = @{ domain = $EmailDomain } })
  })
} | ConvertTo-Json -Depth 10

$existing = (Invoke-RestMethod -Uri $api -Headers $headers).result | Where-Object { $_.domain -eq $Hostname } | Select-Object -First 1
if ($existing) {
  Write-Host "Updating Access application $($existing.id) for $Hostname"
  $null = Invoke-RestMethod -Method Put -Uri "$api/$($existing.id)" -Headers $headers -Body $app
} else {
  Write-Host "Creating Access application for $Hostname"
  $null = Invoke-RestMethod -Method Post -Uri $api -Headers $headers -Body $app
}

# Verify: an unauthenticated request must be redirected to the Access login page
$ok = $false
for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "https://$Hostname/" -MaximumRedirection 0 -UseBasicParsing -ErrorAction SilentlyContinue
  } catch { $r = $_.Exception.Response }
  $location = if ($r.Headers) { "$($r.Headers['Location'])" } else { "" }
  if ($location -like "*cloudflareaccess.com*") { $ok = $true } else { Start-Sleep -Seconds 2 }
}
if (-not $ok) { throw "https://$Hostname/ is not protected by Cloudflare Access; the tunnel is not started" }
Write-Host "Access protection verified (only @$EmailDomain addresses can sign in)"

try { $null = Invoke-WebRequest -Uri "http://localhost:4173/" -UseBasicParsing -TimeoutSec 5 }
catch { throw "The site is not served on http://localhost:4173 (run: cd web; npx vite preview --port 4173)" }

Write-Host "Starting tunnel: https://$Hostname/"
& $Cloudflared --config $TunnelConfig tunnel run
