# Pixiv 知心画廊 一键安装（Windows / PowerShell）
# 用法：powershell -ExecutionPolicy Bypass -c "irm https://github.com/splanternQAQ/dsh-pixiv-Kindred-Gallery/raw/main/install.ps1 | iex"
$ErrorActionPreference = 'Stop'

$repo = 'splanternQAQ/dsh-pixiv-Kindred-Gallery'
$name = 'dsh-pixiv-kindred-gallery'
$zipPrefix = 'dsh-pixiv-Kindred-Gallery'
$destRoot = 'D:\Deepseek_Plugins'
if (-not (Test-Path 'D:\')) { $destRoot = Join-Path $env:USERPROFILE '.dsh\plugins' }
if (-not (Test-Path $destRoot)) { New-Item -ItemType Directory -Path $destRoot -Force | Out-Null }
$dest = Join-Path $destRoot 'dsh-pixiv-Kindred-Gallery'
$profilesRoot = Join-Path $env:USERPROFILE '.dsh\profiles'
$profileDir = $null
if (Test-Path $profilesRoot) {
  $cands = Get-ChildItem $profilesRoot -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'package.json') }
  $desk = $cands | Where-Object { $_.Name -eq 'desktop' } | Select-Object -First 1
  if ($desk) { $profileDir = $desk.FullName }
  elseif ($cands) { $profileDir = ($cands | Select-Object -First 1).FullName }
}
if (-not $profileDir) { throw '找不到 DSH profile 目录（请先启动一次 DSH）' }

Write-Host "==> 下载 $repo" -ForegroundColor Cyan
$tmp = Join-Path $env:TEMP ('pg-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$zip = Join-Path $tmp 'src.zip'
Invoke-WebRequest -Uri "https://codeload.github.com/$repo/zip/refs/heads/main" -OutFile $zip -UseBasicParsing
Expand-Archive -Path $zip -DestinationPath $tmp -Force
$srcDir = (Get-ChildItem $tmp -Directory | Where-Object { $_.Name -like "$zipPrefix-*" } | Select-Object -First 1).FullName
if (-not $srcDir) { throw '解压后找不到源码目录' }

Write-Host "==> 安装到 $dest" -ForegroundColor Cyan
if (Test-Path $dest) {
  $bak = $dest + '.bak-' + (Get-Date -Format 'yyyyMMddHHmmss')
  Move-Item $dest $bak
  Write-Host "   旧版本已备份到 $bak"
}
Move-Item $srcDir $dest

Write-Host '==> 注册到 profile' -ForegroundColor Cyan
$pkgPath = Join-Path $profileDir 'package.json'
if (-not (Test-Path $pkgPath)) { throw "找不到 $pkgPath（请先启动一次 DSH）" }
Copy-Item $pkgPath ($pkgPath + '.bak-' + $name) -Force
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
$link = 'link:' + ($dest -replace '\\', '/')
$pkg.dependencies | Add-Member -NotePropertyName $name -NotePropertyValue $link -Force
if (-not $pkg.dsh) { throw 'profile 的 package.json 没有 dsh 字段' }
$bundles = @($pkg.dsh.profile.bundles)
if ($bundles -notcontains $name) { $pkg.dsh.profile.bundles = @($bundles + $name) }

$json = $pkg | ConvertTo-Json -Depth 20
[IO.File]::WriteAllText($pkgPath, $json, (New-Object System.Text.UTF8Encoding $false))

$nm = Join-Path $profileDir 'node_modules'
$target = Join-Path $nm $name
if (Test-Path $target) { [IO.Directory]::Delete($target, $true) }
New-Item -ItemType Junction -Path $target -Target $dest | Out-Null

Write-Host ''
Write-Host '装好了。' -ForegroundColor Green
Write-Host '下一步：重启 DSH → 打开「知心画廊」→ 设置 → 点「一键安装」装刷Pixiv → 再重启一次 → 登录 pixiv 账号（token 或账号密码）。'
Write-Host '卸载：删掉 profile package.json 里的依赖与 bundles 条目，再删目录即可。'
