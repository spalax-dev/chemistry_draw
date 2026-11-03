#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Fetches the pinned EPAM Indigo Windows x86_64 runtime and generates the
    MSVC import libraries the sidecar links against.

.DESCRIPTION
    Downloads indigo-libs-windows-x86_64.zip 1.46.0, verifies its SHA-256,
    extracts only the runtime DLLs into src-tauri/lib/windows-x86_64/ and
    builds indigo.lib / indigo-renderer.lib from the DLL exports.

    Imago is intentionally absent: the Windows build has no OCR support.

    Requires dumpbin.exe and lib.exe from a Visual Studio x64 developer
    environment. In CI, ilammy/msvc-dev-cmd sets that up.

.PARAMETER OutDir
    Destination directory. Defaults to src-tauri/lib/windows-x86_64 relative
    to the repository root.

.EXAMPLE
    pwsh scripts/fetch-windows-libs.ps1
#>
[CmdletBinding()]
param(
    [string]$OutDir = (Join-Path $PSScriptRoot "..\src-tauri\lib\windows-x86_64")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Windows PowerShell 5.1 can negotiate an older TLS version by default.
[Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$IndigoVersion = "1.46.0"
$DownloadUrl = "https://lifescience.opensource.epam.com/downloads/indigo-$IndigoVersion/indigo-libs-windows-x86_64.zip"
$ExpectedSha256 = "c6fac67a2bd79ed0c39930fa4c031a856055883fec97921e13fef831820ed598"

# Runtime DLLs the sidecar needs next to the executable.
$RuntimeDlls = @(
    "indigo.dll",
    "indigo-renderer.dll",
    "msvcp140.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll"
)

# Import libraries derived from the DLLs at fetch time (never committed).
$ImportLibs = @(
    @{ Dll = "indigo.dll"; Lib = "indigo.lib" },
    @{ Dll = "indigo-renderer.dll"; Lib = "indigo-renderer.lib" }
)

function Get-MsvcTool {
    param([Parameter(Mandatory = $true)][string]$Name)

    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $command) {
        throw @"
Could not find '$Name' on PATH.
Run this script from a Visual Studio x64 developer shell (or let CI run
ilammy/msvc-dev-cmd first) so dumpbin.exe and lib.exe are available.
"@
    }
    return $command.Source
}

function New-ImportLibFromDll {
    param(
        [Parameter(Mandatory = $true)][string]$DllPath,
        [Parameter(Mandatory = $true)][string]$LibPath,
        [Parameter(Mandatory = $true)][string]$Dumpbin,
        [Parameter(Mandatory = $true)][string]$LibTool,
        [Parameter(Mandatory = $true)][string]$WorkDir
    )

    $dllName = Split-Path -Leaf $DllPath
    $exports = & $Dumpbin /nologo /exports $DllPath
    if ($LASTEXITCODE -ne 0) {
        throw "dumpbin /exports failed for $dllName (exit $LASTEXITCODE)."
    }

    # Only the unmangled Indigo C API (all symbols start with `indigo`).
    # Importing C++ internals is unnecessary and fragile.
    $names = [System.Collections.Generic.List[string]]::new()
    foreach ($line in $exports) {
        $parts = $line.Trim() -split "\s+"
        if ($parts.Count -lt 4) { continue }
        if ($parts[0] -notmatch "^\d+$") { continue }
        $symbol = $parts[-1]
        if ($symbol -match "^indigo" -and -not $names.Contains($symbol)) {
            $names.Add($symbol)
        }
    }

    if ($names.Count -eq 0) {
        throw "No 'indigo*' exports found in $dllName; refusing to write an empty $([System.IO.Path]::GetFileName($LibPath))."
    }

    $defPath = Join-Path $WorkDir ("{0}.def" -f [System.IO.Path]::GetFileNameWithoutExtension($LibPath))
    $lines = @("LIBRARY $dllName", "EXPORTS") + ($names | ForEach-Object { "    $_" })
    Set-Content -Path $defPath -Value $lines -Encoding ascii

    & $LibTool "/nologo" "/def:$defPath" "/machine:x64" "/out:$LibPath"
    if ($LASTEXITCODE -ne 0) {
        throw "lib failed for $([System.IO.Path]::GetFileName($LibPath)) (exit $LASTEXITCODE)."
    }
    if (-not (Test-Path -Path $LibPath)) {
        throw "lib did not produce $([System.IO.Path]::GetFileName($LibPath))."
    }

    Write-Host ("  {0}: {1} C API symbols -> {2}" -f $dllName, $names.Count, [System.IO.Path]::GetFileName($LibPath))
}

if ($env:OS -ne "Windows_NT") {
    throw "This script builds Windows import libraries and must run on Windows."
}

$dumpbin = Get-MsvcTool -Name "dumpbin"
$libTool = Get-MsvcTool -Name "lib"
$resolvedOutDir = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Path $resolvedOutDir -Force | Out-Null

$workDir = Join-Path ([System.IO.Path]::GetTempPath()) ("chemistry-draw-indigo-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $workDir -Force | Out-Null
$zipPath = Join-Path $workDir "indigo-libs-windows-x86_64.zip"

try {
    Write-Host "Downloading Indigo $IndigoVersion Windows runtime..."
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $zipPath -UseBasicParsing

    $actualSha256 = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha256 -ne $ExpectedSha256) {
        throw @"
SHA-256 mismatch for indigo-libs-windows-x86_64.zip.
  expected: $ExpectedSha256
  actual:   $actualSha256
Refusing to use an unverified archive.
"@
    }
    Write-Host "SHA-256 verified."

    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
    }
    catch {
        # Already loaded (PowerShell 7 ships it); nothing to do.
    }

    # Extract only the runtime DLLs, wherever they live inside the archive.
    $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
        $entries = @{}
        foreach ($entry in $archive.Entries) {
            $name = [System.IO.Path]::GetFileName($entry.FullName)
            if ($RuntimeDlls -contains $name -and -not $entries.ContainsKey($name)) {
                $entries[$name] = $entry
            }
        }

        $missing = $RuntimeDlls | Where-Object { -not $entries.ContainsKey($_) }
        if ($missing) {
            throw ("Archive is missing expected DLL(s): " + ($missing -join ", "))
        }

        foreach ($name in $RuntimeDlls) {
            $destination = Join-Path $resolvedOutDir $name
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entries[$name], $destination, $true)
        }
    }
    finally {
        $archive.Dispose()
    }

    Write-Host "Generating MSVC import libraries..."
    foreach ($item in $ImportLibs) {
        New-ImportLibFromDll `
            -DllPath (Join-Path $resolvedOutDir $item.Dll) `
            -LibPath (Join-Path $resolvedOutDir $item.Lib) `
            -Dumpbin $dumpbin `
            -LibTool $libTool `
            -WorkDir $workDir
    }

    $missingOutputs = @($RuntimeDlls + ($ImportLibs | ForEach-Object { $_.Lib })) |
        Where-Object { -not (Test-Path -Path (Join-Path $resolvedOutDir $_)) }
    if ($missingOutputs) {
        throw ("Missing expected output(s): " + ($missingOutputs -join ", "))
    }

    Write-Host ""
    Write-Host "Indigo $IndigoVersion Windows runtime ready in $resolvedOutDir"
    Get-ChildItem -Path $resolvedOutDir | Select-Object Name, Length | Format-Table -AutoSize
}
finally {
    Remove-Item -Path $workDir -Recurse -Force -ErrorAction SilentlyContinue
}
