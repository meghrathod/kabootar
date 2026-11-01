# Installs the kabootar command-line client on Windows.
#
#   irm https://kabootar.meghrathod.dev/install.ps1 | iex
#
# Set $env:KABOOTAR_VERSION (e.g. v0.1.0) to pick a release.
$ErrorActionPreference = 'Stop'

$repo = 'meghrathod/kabootar'
$version = if ($env:KABOOTAR_VERSION) { $env:KABOOTAR_VERSION } else { 'latest' }
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { 'amd64' }
  'ARM64' { 'arm64' }
  default { throw "Unsupported architecture $($env:PROCESSOR_ARCHITECTURE)" }
}
$base = if ($version -eq 'latest') {
  "https://github.com/$repo/releases/latest/download"
} else {
  "https://github.com/$repo/releases/download/$version"
}
$archive = "kabootar_windows_$arch.zip"

$tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Downloading $archive..."
  Invoke-WebRequest "$base/$archive" -OutFile "$tmp\$archive" -UseBasicParsing
  Invoke-WebRequest "$base/checksums.txt" -OutFile "$tmp\checksums.txt" -UseBasicParsing

  $line = Get-Content "$tmp\checksums.txt" | Where-Object { $_ -match " $([regex]::Escape($archive))$" }
  if (-not $line) { throw "No checksum for $archive" }
  $expected = ($line -split ' ')[0]
  $actual = (Get-FileHash "$tmp\$archive" -Algorithm SHA256).Hash.ToLower()
  if ($expected -ne $actual) { throw "Checksum mismatch for $archive" }

  Expand-Archive "$tmp\$archive" -DestinationPath $tmp -Force
  $dir = Join-Path $env:LOCALAPPDATA 'Programs\kabootar'
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  Move-Item "$tmp\kabootar.exe" "$dir\kabootar.exe" -Force

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($userPath -split ';') -notcontains $dir) {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$dir", 'User')
    Write-Host "Added $dir to your PATH (open a new terminal to use it)."
  }
  Write-Host "Installed $(& "$dir\kabootar.exe" version) to $dir\kabootar.exe"
  Write-Host 'Try: kabootar send <file>'
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
