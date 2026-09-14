# 安装 screen-control 预设
#
# 把 preset/ 复制到 DSH 的预设根目录，使其出现在预设选择器里。
# 用法:  powershell -ExecutionPolicy Bypass -File .\install.ps1

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $here 'preset'

if (-not (Test-Path $src)) { throw "找不到 preset 目录: $src" }

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$root = Join-Path $dshHome '.agent-presets'
$dest = Join-Path $root 'screen-control'

Write-Host "DSH_HOME : $dshHome"
Write-Host "预设根   : $root"
Write-Host "目标     : $dest"
Write-Host ''

if (Test-Path $dest) {
  Write-Host '目标已存在，先备份为 screen-control.bak' -ForegroundColor Yellow
  $bak = "$dest.bak"
  if (Test-Path $bak) { Remove-Item $bak -Recurse -Force }
  Move-Item $dest $bak
}

New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force

# 校验
$need = @(
  'agent.cordis.yml',
  'preset.yml',
  'screen-control-plugin\plugin\index.mjs',
  'screen-control-plugin\plugin\win32.mjs',
  'screen-control-plugin\plugin\tools.mjs'
)
$missing = @()
foreach ($n in $need) { if (-not (Test-Path (Join-Path $dest $n))) { $missing += $n } }

if ($missing.Count -gt 0) {
  Write-Host '安装不完整，缺少:' -ForegroundColor Red
  $missing | ForEach-Object { Write-Host "  - $_" }
  exit 1
}

Write-Host '安装完成。' -ForegroundColor Green
Write-Host ''
Write-Host '下一步：'
Write-Host '  1. 重启 DSH'
Write-Host '  2. 新建会话，在预设选择器里选「屏幕操作」'
Write-Host ''
Write-Host '截图会写到：'
Write-Host "  $dest\screenshots\"
