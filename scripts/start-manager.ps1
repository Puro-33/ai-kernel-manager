param([int]$Port = 4317, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$managerUrl = "http://127.0.0.1:$Port"
if ($Port -lt 1 -or $Port -gt 65535) { throw 'Port must be between 1 and 65535.' }
try {
    $health = Invoke-RestMethod -Uri "$managerUrl/health" -TimeoutSec 2
} catch { $health = $null }
if ($health -and $health.app -ne 'kernel-deck') { throw "Port $Port is in use by another application." }
if (-not $health) {
    $bundledNode = Join-Path $projectRoot 'runtime\node.exe'
    if (Test-Path -LiteralPath $bundledNode) {
        $nodePath = $bundledNode
        $env:Path = (Split-Path -Parent $bundledNode) + ';' + $env:Path
    }
    else { $nodePath = (Get-Command node.exe -ErrorAction Stop).Source }
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist\index.html'))) { throw 'Run npm install and npm run build before starting from source.' }
    $dataPath = Join-Path $projectRoot '.data'
    New-Item -ItemType Directory -Force -Path $dataPath | Out-Null
    $env:PORT = [string]$Port
    $env:KERNEL_DECK_DATA_DIR = $dataPath
    $serverPath = Join-Path $projectRoot 'server\index.mjs'
    $managerProcess = Start-Process -FilePath $nodePath -ArgumentList @(('"' + $serverPath + '"')) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataPath 'server.log') -RedirectStandardError (Join-Path $dataPath 'server-error.log') -PassThru
    $deadline = (Get-Date).AddSeconds(20)
    do {
        if ($managerProcess.HasExited) { throw "Kernel Deck failed to start. Check $dataPath\server-error.log" }
        Start-Sleep -Milliseconds 250
        try { $health = Invoke-RestMethod -Uri "$managerUrl/health" -TimeoutSec 1 } catch { $health = $null }
    } until (($health -and $health.app -eq 'kernel-deck') -or (Get-Date) -ge $deadline)
    if (-not $health -or $health.app -ne 'kernel-deck') { throw "Kernel Deck did not become ready. Check $dataPath\server-error.log" }
}
Write-Output "Kernel Deck: $managerUrl"
Write-Output 'Closing the browser keeps sessions running. Use stop.cmd to stop the server and its sessions.'
if (-not $NoBrowser) { Start-Process $managerUrl }
