param([switch]$NoBrowser, [switch]$Rebuild, [switch]$Stop, [string]$EdgeProfile = "")

$ErrorActionPreference = "Stop"
$projectRoot = $PSScriptRoot
$runtimeDirectory = Join-Path $projectRoot ".runtime\local"
$serverScript = Join-Path $projectRoot "scripts\local\server.mjs"
$address = "https://192.168.123.232:3001"
$node = (Get-Command node.exe -ErrorAction Stop).Source
if ($Stop) {
    $pidFile = Join-Path $runtimeDirectory "server.pid"
    if (-not (Test-Path -LiteralPath $pidFile)) { Write-Host "没有本启动器记录的服务。"; return }
    $serverProcessId = [int](Get-Content -LiteralPath $pidFile -Raw)
    $running = Get-CimInstance Win32_Process -Filter "ProcessId=$serverProcessId"
    if (-not $running) { Write-Host "本机服务已经停止。"; return }
    if ($running.ExecutablePath -ne $node -or -not $running.CommandLine.Contains($serverScript)) { throw "PID已属于其他程序，拒绝停止。" }
    if ((Read-Host "请先确认生成任务已结束。输入 STOP 停止本机后台（不关闭Edge、不删除素材）") -eq "STOP") {
        Stop-Process -Id $serverProcessId
        Write-Host "已停止本机后台。"
    }
    return
}
$edgeData = Join-Path $env:LOCALAPPDATA "Microsoft\Edge\User Data"
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
# The HTTPS private key stays local; no OS trust store, hosts file or network settings are changed.
$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$runtimeAcl = Get-Acl -LiteralPath $runtimeDirectory
$ownAccess = $runtimeAcl.Access | Where-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $userSid -and $_.AccessControlType -eq "Allow" -and $_.FileSystemRights.HasFlag([System.Security.AccessControl.FileSystemRights]::FullControl) }
if (-not $runtimeAcl.AreAccessRulesProtected -or -not $ownAccess) {
    & icacls.exe $runtimeDirectory /inheritance:r /grant:r "*${userSid}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" *> $null
    if ($LASTEXITCODE -ne 0) { throw "无法限制本机HTTPS私钥目录权限，已停止。" }
}

$fingerprint = (& $node $serverScript --fingerprint).Trim()
if ($LASTEXITCODE -ne 0) { throw "无法读取当前构建版本。" }
$buildFile = Join-Path $runtimeDirectory "build.json"
$built = if (Test-Path -LiteralPath $buildFile) { Get-Content -LiteralPath $buildFile -Raw | ConvertFrom-Json } else { $null }
if ($Rebuild -or $built.fingerprint -ne $fingerprint -or -not $built.dist -or -not (Test-Path (Join-Path $built.dist "index.html")) -or -not (Test-Path (Join-Path $projectRoot "canvas-proxy\node_modules\tencentcloud-sdk-nodejs-common\package.json"))) {
    Write-Host "首次启动或源码有更新：按Docker相同的Bun版本与锁文件安装依赖、构建当前前端..."
    $buildDirectory = (& $node $serverScript --prepare-build).Trim()
    if ($LASTEXITCODE -ne 0) { throw "无法准备独立构建目录。" }
    foreach ($folder in @("web", "canvas-proxy")) {
        $workingDirectory = if ($folder -eq "web") { Join-Path $buildDirectory "web" } else { Join-Path $projectRoot $folder }
        Push-Location $workingDirectory
        try {
            & npm.cmd --cache (Join-Path $runtimeDirectory "npm-cache") exec --yes --package=bun@1.3.13 -- bun install --frozen-lockfile --cache-dir (Join-Path $runtimeDirectory "bun-cache")
            if ($LASTEXITCODE -ne 0) { throw "$folder 依赖安装失败；未打开浏览器。" }
            if ($folder -eq "web") {
                & npm.cmd --cache (Join-Path $runtimeDirectory "npm-cache") exec --yes --package=bun@1.3.13 -- bun run build
                if ($LASTEXITCODE -ne 0) { throw "前端构建失败；未打开浏览器。" }
            }
        } finally { Pop-Location }
    }
    @{ fingerprint = $fingerprint; dist = (Join-Path $buildDirectory "web\dist") } | ConvertTo-Json | Set-Content -LiteralPath $buildFile -Encoding UTF8
}

$certFile = Join-Path $runtimeDirectory "cert.pem"
$keyFile = Join-Path $runtimeDirectory "key.pem"
if (-not (Test-Path -LiteralPath $certFile) -or -not (Test-Path -LiteralPath $keyFile)) {
    $openssl = @((Get-Command openssl.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source), "$env:ProgramFiles\Git\usr\bin\openssl.exe", "$env:ProgramFiles\Git\mingw64\bin\openssl.exe") | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
    if (-not $openssl) { throw "未找到OpenSSL。请安装Git for Windows后重试（用于生成本机专用HTTPS证书）。" }
    $certProcess = Start-Process -FilePath $openssl -ArgumentList @("req", "-x509", "-newkey", "rsa:2048", "-noenc", "-sha256", "-days", "365", "-subj", '"/CN=Infinite Canvas Local"', "-addext", '"subjectAltName=IP:192.168.123.232,IP:127.0.0.1,DNS:localhost"', "-keyout", ('"' + $keyFile + '"'), "-out", ('"' + $certFile + '"')) -WindowStyle Hidden -Wait -PassThru -RedirectStandardError (Join-Path $runtimeDirectory "certificate.log")
    if ($certProcess.ExitCode -ne 0) { throw "本机HTTPS证书生成失败。" }
}
$pin = (& $node $serverScript --pin).Trim()
if ($LASTEXITCODE -ne 0) { throw "无法读取本机HTTPS公钥摘要。" }

# Probe only loopback, and pin this generated certificate rather than disabling TLS validation.
function Get-LocalStatus {
    $result = & $node $serverScript --status
    if ($LASTEXITCODE -eq 0 -and $result) { return ($result | ConvertFrom-Json) }
    return $null
}
$status = Get-LocalStatus
if ($status -and $status.app -ne "infinite-canvas-local") { throw "3001端口不是本启动器的服务，未尝试停止。" }
if ($status -and $status.build -ne $fingerprint) { throw "旧版本机服务仍在运行。请先等生成结束，再按说明停止旧服务后重开；不会强行中断任务。" }
if (-not $status) {
    $process = Start-Process -FilePath $node -ArgumentList ('"' + $serverScript + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDirectory "server.stdout.log") -RedirectStandardError (Join-Path $runtimeDirectory "server.stderr.log") -PassThru
    $process.Id | Set-Content (Join-Path $runtimeDirectory "server.pid")
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 300
        $status = Get-LocalStatus
        if ($status) { break }
        if ($process.HasExited) { break }
    }
    if (-not $status) { throw "本机HTTPS服务未启动，请查看.runtime\local\server.stderr.log；不会停止其他占用端口的程序。" }
}
Write-Host "本机服务就绪：$address"
Write-Host "任务文件：task-data\local；完成后固定保留24小时。电脑必须保持开机且不能休眠。"
if ($NoBrowser) { return }
if (-not $edge -or -not (Test-Path -LiteralPath $edgeData)) { throw "未找到原Edge配置。不能新建配置代替旧数据，请检查原来使用的浏览器。" }

$mapping = "MAP 192.168.123.232:3001 127.0.0.1:3001"
$mappedEdge = Get-CimInstance Win32_Process -Filter "name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($mapping) -and $_.CommandLine.Contains("--ignore-certificate-errors-spki-list=$pin") }
if (-not $mappedEdge) {
    while (Get-Process msedge -ErrorAction SilentlyContinue) {
        Write-Host "请先保存并完全退出Edge（包括后台进程），让本机映射生效。脚本不会强关浏览器。"
        Read-Host "关闭后按回车继续；要取消请按Ctrl+C" | Out-Null
    }
    # Back up ONLY this origin's IndexedDB files; never inspect unrelated origins or credentials.
    $backup = Join-Path $projectRoot "data\local-browser-backup"
    if (-not (Test-Path -LiteralPath (Join-Path $backup "complete.json"))) {
        $copied = 0
        $backupRun = Join-Path $backup ([guid]::NewGuid().ToString())
        foreach ($profile in (Get-ChildItem -LiteralPath $edgeData -Directory | Where-Object { $_.Name -eq "Default" -or $_.Name -match '^Profile \d+$' })) {
            $db = Join-Path $profile.FullName "IndexedDB"
            if (-not (Test-Path -LiteralPath $db)) { continue }
            foreach ($item in (Get-ChildItem -LiteralPath $db | Where-Object { $_.Name -like "https_192.168.123.232_3001.indexeddb.*" })) {
                New-Item -ItemType Directory -Path $backup -Force | Out-Null
                & icacls.exe $backup /inheritance:r /grant:r "*${userSid}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" *> $null
                if ($LASTEXITCODE -ne 0) { throw "无法限制旧数据备份目录权限，已停止。" }
                $destination = Join-Path $backupRun $profile.Name
                New-Item -ItemType Directory -Path $destination -Force | Out-Null
                Write-Host "正在备份旧地址的IndexedDB：$($profile.Name)..."
                Copy-Item -LiteralPath $item.FullName -Destination $destination -Recurse
                $copied++
            }
        }
        if ($copied) { @{ directories = $copied; origin = $address } | ConvertTo-Json | Set-Content (Join-Path $backup "complete.json") -Encoding UTF8; Write-Host "旧地址IndexedDB已备份到data\local-browser-backup（包含私密配置，请勿分享）。" }
        else { Write-Warning "未在标准Edge配置目录找到该地址的IndexedDB；不代表数据已丢失。若画布为空，请停止操作并核对原浏览器和配置，不要清理存储。" }
    }
}
$edgeArguments = @("--host-resolver-rules=`"$mapping`"", "--ignore-certificate-errors-spki-list=$pin", "--user-data-dir=`"$edgeData`"", "--new-window", $address)
if ($EdgeProfile) { $edgeArguments += "--profile-directory=`"$EdgeProfile`"" }
Start-Process -FilePath $edge -ArgumentList $edgeArguments
Write-Host "已打开原地址，请使用原来保存画布的Edge用户配置。不会迁移、覆盖或清理浏览器数据。"
