param([int]$Port = 4317)
$ErrorActionPreference = 'Stop'
$managerUrl = "http://127.0.0.1:$Port"
if ($Port -lt 1 -or $Port -gt 65535) { throw 'Port must be between 1 and 65535.' }
$health = Invoke-RestMethod -Uri "$managerUrl/health" -TimeoutSec 3
if ($health.app -ne 'kernel-deck') { throw 'This port is not a Kernel Deck server.' }
Invoke-WebRequest -UseBasicParsing -Uri $managerUrl -SessionVariable managerSession -TimeoutSec 3 | Out-Null
Invoke-RestMethod -Method Post -Uri "$managerUrl/api/shutdown" -WebSession $managerSession -ContentType 'application/json' -Body '{}' -Headers @{ Origin = $managerUrl } -TimeoutSec 5 | Out-Null
Write-Output 'Kernel Deck is stopping its sessions and server.'
