$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$runtimeDirectory = Join-Path $projectRoot ".runtime"
if (Test-NetConnection -ComputerName 127.0.0.1 -Port 23210 -InformationLevel Quiet -WarningAction SilentlyContinue) {
    Write-Host "Seedance bridge 已在运行：http://127.0.0.1:23210"
    exit 0
}
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw "未找到 Node.js。请先安装 Node.js。" }
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
$process = Start-Process -FilePath "node.exe" -ArgumentList ".\\canvas-proxy\\index.js" -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDirectory "seedance-bridge.stdout.log") -RedirectStandardError (Join-Path $runtimeDirectory "seedance-bridge.stderr.log") -PassThru
Write-Host "Seedance bridge 已启动（PID $($process.Id)）：http://127.0.0.1:23210"
