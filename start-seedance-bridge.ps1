$ErrorActionPreference = "Stop"

$restart = $args -contains "-Restart"
$projectRoot = $PSScriptRoot
$runtimeDirectory = Join-Path $projectRoot ".runtime"
$bridgePort = 23210
$listener = netstat -ano -p tcp | Select-String "^\s*TCP\s+127\.0\.0\.1:$bridgePort\s+.*LISTENING\s+(\d+)\s*$" | Select-Object -First 1

if ($listener -and $restart) {
    $processId = [int]$listener.Matches[0].Groups[1].Value
    Stop-Process -Id $processId -Force
    Start-Sleep -Milliseconds 300
    $listener = $null
    Write-Host "已停止旧版 Seedance bridge（PID $processId），正在加载当前代码..."
}

if ($listener) {
    Write-Host "Seedance bridge 已在运行：http://127.0.0.1:$bridgePort"
    exit 0
}
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw "未找到 Node.js。请先安装 Node.js。" }
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
$stdoutLog = Join-Path $runtimeDirectory "seedance-bridge.stdout.log"
$stderrLog = Join-Path $runtimeDirectory "seedance-bridge.stderr.log"
$process = Start-Process -FilePath "node.exe" -ArgumentList ".\\canvas-proxy\\index.js" -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 300
    if (Test-NetConnection -ComputerName 127.0.0.1 -Port $bridgePort -InformationLevel Quiet -WarningAction SilentlyContinue) {
        Write-Host "Seedance bridge 已启动（PID $($process.Id)）：http://127.0.0.1:$bridgePort"
        exit 0
    }
}
throw "Seedance bridge 未能在 6 秒内启动。请查看日志：$stderrLog"
