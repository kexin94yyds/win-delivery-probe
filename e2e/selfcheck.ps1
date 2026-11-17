# iterate Windows 弹窗回复自查（只读）
# 用法：在 PowerShell 里运行
#   powershell -ExecutionPolicy Bypass -File .\iterate-windows-selfcheck.ps1
# 只读取配置、进程和日志；只在 %TEMP% 里建两个测试小文件，测完立即删除。
# 不修改 Codex 配置，不结束任何进程。报告保存在桌面 iterate-selfcheck-<时间>.txt，
# 里面的用户名已替换成 <USER>，不包含对话内容、token 或密钥。

$ErrorActionPreference = 'Continue'
$report = New-Object System.Collections.Generic.List[string]
function Say([string]$text) { $report.Add($text); Write-Host $text }
function Hash([string]$p) {
  try { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() } catch { "无法计算: $($_.Exception.Message)" }
}
$userName = $env:USERNAME

Say "=== iterate Windows 自查 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="
$os = Get-CimInstance Win32_OperatingSystem
Say "Windows: $($os.Caption) build $($os.BuildNumber)"

# 1. Codex 配置里 iterate 指向哪个 exe、等待多久
Say ""
Say "--- 1. Codex 配置 ---"
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$config = Join-Path $codexHome 'config.toml'
$configuredCommand = $null
if (Test-Path -LiteralPath $config) {
  $section = $null
  foreach ($line in Get-Content -LiteralPath $config -Encoding UTF8) {
    $t = $line.Trim()
    if ($t -match '^\[(.+)\]$') { $section = $Matches[1]; continue }
    if ($section -and $section -match '^mcp_servers\.' -and $section -match 'iterate|cunzhi|zhi') {
      if ($t -match '^(command|args|tool_timeout_sec|startup_timeout_sec|url)\s*=') {
        Say "[$section] $t"
        if ($t -match '^command\s*=\s*["''](.+)["'']\s*$') { $configuredCommand = $Matches[1] -replace '\\\\', '\' }
      }
    }
  }
  if (-not $configuredCommand) { Say "没有找到 iterate 的 command（可能条目名不同，或用的是 url）" }
  else {
    Say "command 指向: $configuredCommand"
    if (Test-Path -LiteralPath $configuredCommand) {
      $item = Get-Item -LiteralPath $configuredCommand
      Say "  大小 $($item.Length)，修改时间 $($item.LastWriteTime)，SHA-256 $(Hash $configuredCommand)"
      $iterateNext = Join-Path $item.DirectoryName 'iterate.exe'
      if (Test-Path -LiteralPath $iterateNext) { Say "  同目录 iterate.exe SHA-256 $(Hash $iterateNext)，修改时间 $((Get-Item -LiteralPath $iterateNext).LastWriteTime)" }
      else { Say "  同目录没有 iterate.exe（mcp-server 会去 PATH 里找，可能找到别的版本）" }
    } else { Say "  !! 这个文件不存在" }
  }
  Say "提示：tool_timeout_sec 没写时 Codex 只等 60 秒。建议 tool_timeout_sec = 315360000，改完要重启 Codex。"
} else { Say "没有找到 $config" }

# 2. 现在正在运行的 iterate / mcp-server 是哪个文件、被谁启动
Say ""
Say "--- 2. 正在运行的进程 ---"
$procs = Get-CimInstance Win32_Process -Filter "Name='iterate.exe' OR Name='mcp-server.exe'"
if (-not $procs) { Say "没有在运行（先让 Codex 调一次 call_zhi，弹窗出现时再运行本脚本更有用）" }
foreach ($p in $procs) {
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue
  $mode = if ($p.CommandLine -match '--serve') { 'serve' } elseif ($p.CommandLine -match '--mcp-request') { 'popup' } elseif ($p.Name -eq 'mcp-server.exe') { 'mcp-server' } else { 'main' }
  Say "$($p.Name) pid=$($p.ProcessId) 角色=$mode 父进程=$($parent.Name)($($p.ParentProcessId)) 启动=$($p.CreationDate)"
  Say "  路径 $($p.ExecutablePath)"
  Say "  SHA-256 $(Hash $p.ExecutablePath)"
}

# 3. 电脑上所有的 iterate.exe / mcp-server.exe
Say ""
Say "--- 3. 已安装的副本 ---"
$roots = @("$env:LOCALAPPDATA\iterate", "$env:LOCALAPPDATA\Programs", "$env:ProgramFiles", "${env:ProgramFiles(x86)}", "$env:USERPROFILE\Downloads", "$env:USERPROFILE\Desktop") | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
foreach ($r in $roots) {
  Get-ChildItem -LiteralPath $r -Recurse -Depth 4 -File -Include 'iterate.exe', 'mcp-server.exe' -ErrorAction SilentlyContinue | ForEach-Object {
    $v = $_.VersionInfo.FileVersion
    Say "$($_.FullName)  版本 $v  大小 $($_.Length)  修改 $($_.LastWriteTime)  SHA-256 $(Hash $_.FullName)"
  }
}

# 4. %TEMP% 的文件系统，以及回复发布用到的三个系统操作能不能成功
Say ""
Say "--- 4. %TEMP% 能力测试 ---"
$temp = [System.IO.Path]::GetTempPath()
Say "TEMP = $temp"
try { $vol = Get-Volume -DriveLetter $temp[0] -ErrorAction Stop; Say "文件系统 = $($vol.FileSystemType)，剩余 $([math]::Round($vol.SizeRemaining/1GB,1)) GB" } catch { Say "文件系统 = 无法读取: $($_.Exception.Message)" }
$a = Join-Path $temp "iterate_selfcheck_$PID.pending"
$b = Join-Path $temp "iterate_selfcheck_$PID.json"
try {
  $fs = [System.IO.File]::Open($a, 'CreateNew', 'Write', 'ReadWrite')
  $bytes = [System.Text.Encoding]::UTF8.GetBytes('{"probe":true}')
  $fs.Write($bytes, 0, $bytes.Length)
  try { $fs.Flush($true); Say "落盘（可写句柄 FlushFileBuffers）: 成功" } catch { Say "落盘（可写句柄）: 失败 $($_.Exception.InnerException.Message)" }
  $fs.Close()
  try { New-Item -ItemType HardLink -Path $b -Target $a -ErrorAction Stop | Out-Null; Say "硬链接: 成功" } catch { Say "硬链接: 失败 $($_.Exception.Message)  ← 0.7.2 和 v0.7.2-fix 都会因此回复失败" }
} catch { Say "测试文件创建失败: $($_.Exception.Message)" }
finally { Remove-Item -LiteralPath $a, $b -Force -ErrorAction SilentlyContinue }

try {
  $av = Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop | ForEach-Object { $_.displayName }
  Say "安全软件: $($av -join ', ')"
} catch { Say "安全软件: 无法读取" }

# 5. 日志里和回复送达相关的行
Say ""
Say "--- 5. 日志 ---"
$instanceLog = Join-Path $temp 'iterate-instance-debug.log'
if (Test-Path -LiteralPath $instanceLog) {
  Say "[iterate-instance-debug.log 最后 60 条相关行]"
  Get-Content -LiteralPath $instanceLog -Tail 3000 -Encoding UTF8 | Select-String -Pattern 'serve-request|handle-dialog|dialog-http|delivery|response' | Select-Object -Last 60 | ForEach-Object { Say $_.Line }
} else { Say "没有 $instanceLog" }
foreach ($tl in @((Join-Path $env:USERPROFILE 'Library\Logs\iterate\timeline-debug.log'), (Join-Path $temp 'iterate\timeline-debug.log'))) {
  if (Test-Path -LiteralPath $tl) {
    Say "[$tl 里的发送失败记录（新测试包才有）]"
    Get-Content -LiteralPath $tl -Tail 3000 -Encoding UTF8 | Select-String -Pattern 'send_mcp_response:error' | Select-Object -Last 20 | ForEach-Object { Say $_.Line }
  }
}
Say "[%TEMP% 里残留的回复相关文件]"
Get-ChildItem -LiteralPath $temp -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^iterate_(response|delivery|request|ready)|\.response\.claim$|\.pending-' } | Select-Object -Last 40 | ForEach-Object { Say "$($_.Name)  $($_.Length)  $($_.LastWriteTime)" }

$out = Join-Path ([Environment]::GetFolderPath('Desktop')) ("iterate-selfcheck-{0}.txt" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
($report -join "`r`n").Replace($userName, '<USER>') | Set-Content -LiteralPath $out -Encoding UTF8
Write-Host ""
Write-Host "报告已保存: $out  —— 把这个文件发给 iterate 开发者即可。"
