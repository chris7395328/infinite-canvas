param([switch]$SeedanceBridge)

$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$webDirectory = Join-Path $projectRoot "web"
$port = 3000
$address = "http://localhost:$port"
$runtimeDirectory = Join-Path $projectRoot ".runtime"

if (-not (Test-Path (Join-Path $webDirectory "package.json"))) {
    throw "未找到 web/package.json，请将此脚本保留在 infinite-canvas 项目根目录。"
}

$isRunning = Test-NetConnection -ComputerName 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue
if ($isRunning) {
    Write-Host "无限画布已在运行：$address"
} elseif (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw "未找到 npm。请先安装 Node.js，再重新运行此脚本。"
} else {
    New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
    $stdoutLog = Join-Path $runtimeDirectory "infinite-canvas.stdout.log"
    $stderrLog = Join-Path $runtimeDirectory "infinite-canvas.stderr.log"

    $process = Start-Process -FilePath "npm.cmd" -ArgumentList "run", "start" -WorkingDirectory $webDirectory -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
    Write-Host "正在启动无限画布（启动器 PID $($process.Id)）..."

    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 500
        $isRunning = Test-NetConnection -ComputerName 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue
        if ($isRunning) {
            Write-Host "启动完成：$address"
            break
        }
    }
    if (-not $isRunning) { Write-Error "服务未能在 10 秒内启动。请查看日志：$stderrLog" }
}

if ($SeedanceBridge) {
    & (Join-Path $projectRoot "start-seedance-bridge.ps1")
}
