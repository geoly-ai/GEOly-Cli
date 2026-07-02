# GEOly CLI installer (Windows) — https://www.geoly.ai
#   irm https://geoly.ai/install.ps1 | iex
#   (mirror: irm https://raw.githubusercontent.com/geoly-ai/GEOly-Cli/main/install.ps1 | iex)
#
# Zero-interaction: installs to %LOCALAPPDATA%\Programs\geoly, verifies sha256,
# adds the directory to the *user* PATH (no admin rights required).
# Env overrides: GEOLY_INSTALL_BASE (release base URL), GEOLY_VERSION (pin, e.g. v0.1.0)
$ErrorActionPreference = 'Stop'

# Only https + known hosts may serve the manifest and binaries (a poisoned
# env var must not redirect the install to an attacker host).
function Test-AllowedUrl([string]$u) {
  try { $uri = [uri]$u } catch { return $false }
  if ($uri.Scheme -ne 'https') { return $false }
  $h = $uri.Host
  return ($h -eq 'github.com' -or $h -eq 'objects.githubusercontent.com' -or $h -eq 'raw.githubusercontent.com' -or $h -eq 'geoly.ai' -or $h.EndsWith('.geoly.ai'))
}

$repoBase = if ($env:GEOLY_INSTALL_BASE) { $env:GEOLY_INSTALL_BASE } else { 'https://github.com/geoly-ai/GEOly-Cli/releases' }
if (-not (Test-AllowedUrl "$repoBase/x")) { throw "geoly install: GEOLY_INSTALL_BASE must be https on github.com / *.geoly.ai, got: $repoBase" }
$manifestUrl = if ($env:GEOLY_VERSION) { "$repoBase/download/$($env:GEOLY_VERSION)/manifest.json" } else { "$repoBase/latest/download/manifest.json" }

$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { 'x64' }
  'ARM64' { 'arm64' }
  default { throw "geoly install: unsupported architecture $($env:PROCESSOR_ARCHITECTURE)" }
}
if ($env:GEOLY_ARCH) { $arch = $env:GEOLY_ARCH }

Write-Host "==> Fetching manifest: $manifestUrl"
try { $manifest = Invoke-RestMethod -Uri $manifestUrl -TimeoutSec 30 }
catch { throw "geoly install: could not download the release manifest (no release published yet?)" }
if (-not $manifest.latest) { throw 'geoly install: manifest is malformed' }

$entry = $manifest.files | Where-Object { $_.os -eq 'windows' -and $_.arch -eq $arch } | Select-Object -First 1
if (-not $entry) { $entry = $manifest.files | Where-Object { $_.os -eq 'windows' -and $_.arch -eq "$arch-baseline" } | Select-Object -First 1 }
if (-not $entry) { throw "geoly install: no binary published for windows/$arch" }

if (-not (Test-AllowedUrl $entry.url)) { throw "geoly install: refusing binary from untrusted URL: $($entry.url)" }

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "geoly-install-$PID"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$pkg = Join-Path $tmp 'geoly.gz'
Write-Host "==> Downloading geoly v$($manifest.latest) (windows/$arch)"
Invoke-WebRequest -Uri $entry.url -OutFile $pkg -TimeoutSec 300

$got = (Get-FileHash -Algorithm SHA256 -Path $pkg).Hash.ToLowerInvariant()
if ($got -ne $entry.sha256.ToLowerInvariant()) {
  throw "geoly install: checksum mismatch (expected $($entry.sha256), got $got) — refusing to install"
}

# Decompress the gzip stream to the final exe.
$destDir = Join-Path $env:LOCALAPPDATA 'Programs\geoly'
New-Item -ItemType Directory -Force -Path $destDir | Out-Null
$exe = Join-Path $destDir 'geoly.exe'
$in = [System.IO.File]::OpenRead($pkg)
try {
  $gz = New-Object System.IO.Compression.GZipStream($in, [System.IO.Compression.CompressionMode]::Decompress)
  $out = [System.IO.File]::Create("$exe.tmp")
  try { $gz.CopyTo($out) } finally { $out.Dispose(); $gz.Dispose() }
} finally { $in.Dispose() }
Move-Item -Force "$exe.tmp" $exe
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Write-Host "==> Installed: $exe (v$($manifest.latest))"

# User-level PATH (current session + persistent), no admin needed.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $destDir) {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$destDir", 'User')
  Write-Host "==> Added $destDir to your user PATH (new terminals pick it up automatically)"
}
if (($env:Path -split ';') -notcontains $destDir) { $env:Path = "$env:Path;$destDir" }

Write-Host '==> Try: geoly tools    (first call opens your browser to authorize)'
