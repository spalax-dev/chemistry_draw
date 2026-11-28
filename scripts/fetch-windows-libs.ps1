#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Fetches the pinned EPAM Indigo Windows x86_64 runtime and ONNX Runtime,
    and generates the MSVC import libraries the sidecar links against.

.DESCRIPTION
    Downloads indigo-libs-windows-x86_64.zip 1.49.0, verifies its SHA-256,
    extracts only the runtime DLLs into src-tauri/lib/windows-x86_64/ and
    builds indigo.lib / indigo-renderer.lib from the DLL exports.

    Indigo is pinned to the stable 1.49.0 release on both platforms (ADR 0011).
    `master` reports a `1.51.0-dev...` version string through /v2/info, which
    the E1 contract rejects, so the Windows ZIP is pinned to 1.49.0 and its
    SHA-256 is verified before anything is extracted. Linux clones the matching
    `indigo-1.49.0` tag with a tag guard in scripts/build-libs.sh.

    It also downloads the pinned ONNX Runtime 1.31.0 from the official
    Microsoft.ML.OnnxRuntime NuGet package (the GitHub release asset is gone),
    verifies the package SHA-256 and the DLL SHA-256/size, and extracts
    onnxruntime.dll next to the Indigo DLLs. A .nupkg is a zip archive; the PyPI
    wheel carries a different library and must not be used. The sidecar loads
    the runtime dynamically through ORT_DYLIB_PATH, so the DLL is shipped but
    never linked at build time.

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

# Indigo 1.49.0 is the stable tag pinned on Linux too (git ref
# `indigo-1.49.0`, release name `Indigo-1.49.0`); keeping both platforms on the
# same version keeps /v2/info.indigo_version consistent.
$IndigoVersion = "1.49.0"
$DownloadUrl = "https://lifescience.opensource.epam.com/downloads/indigo-$IndigoVersion/indigo-libs-windows-x86_64.zip"
$ExpectedSha256 = "5bd405cc4c2b19521b88e015e7266f1a2914bc7d5ca7b769f1e1c16378871515"

$OnnxRuntimeVersion = "1.31.0"
$OnnxRuntimePackage = "microsoft.ml.onnxruntime.$OnnxRuntimeVersion.nupkg"
$OnnxRuntimeUrl = "https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/$OnnxRuntimeVersion/microsoft.ml.onnxruntime.$OnnxRuntimeVersion.nupkg"
$OnnxRuntimeSha256 = "7e35fdb4f5adb62f01e60798e2e5ed05108f5fbbe1cca03fbcc37903cf7c5e3b"
$OnnxRuntimeDll = "onnxruntime.dll"
$OnnxRuntimeDllSha256 = "0c42dc4e278f0968fdf9ebf1b1e54a74c657a9942e70803e453c91993451cf4c"
$OnnxRuntimeDllSize = 17253176

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

    # ONNX Runtime: the sidecar loads it dynamically through ORT_DYLIB_PATH,
    # so the DLL ships next to the Indigo runtimes but is never linked. The
    # pinned source is the official NuGet package; a .nupkg is a zip archive.
    $ortPackagePath = Join-Path $workDir $OnnxRuntimePackage

    Write-Host "Downloading ONNX Runtime $OnnxRuntimeVersion from NuGet..."
    Invoke-WebRequest -Uri $OnnxRuntimeUrl -OutFile $ortPackagePath -UseBasicParsing

    $actualOrtSha256 = (Get-FileHash -Path $ortPackagePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualOrtSha256 -ne $OnnxRuntimeSha256) {
        throw @"
SHA-256 mismatch for $OnnxRuntimePackage.
  expected: $OnnxRuntimeSha256
  actual:   $actualOrtSha256
Refusing to use an unverified package.
If the pin changed, move OnnxRuntimeUrl, ortEntryPath, OnnxRuntimeSha256
and OnnxRuntimeDllSha256 together.
"@
    }
    Write-Host "ONNX Runtime package SHA-256 verified."

    # Entry-level extraction: the package carries every platform, headers and
    # metadata, so read just the Windows DLL entry, like the Indigo extraction
    # above. Never expand the whole archive.
    $ortEntryPath = "runtimes/win-x64/native/onnxruntime.dll"
    $ortDestination = Join-Path $resolvedOutDir $OnnxRuntimeDll

    $ortArchive = [System.IO.Compression.ZipFile]::OpenRead($ortPackagePath)
    try {
        $ortEntry = $ortArchive.GetEntry($ortEntryPath)
        if (-not $ortEntry) {
            throw "Package $OnnxRuntimePackage does not contain $ortEntryPath."
        }
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($ortEntry, $ortDestination, $true)
    }
    finally {
        $ortArchive.Dispose()
    }

    $ortDllSha256 = (Get-FileHash -Path $ortDestination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ortDllSha256 -ne $OnnxRuntimeDllSha256) {
        throw @"
SHA-256 mismatch for $OnnxRuntimeDll.
  expected: $OnnxRuntimeDllSha256
  actual:   $ortDllSha256
Refusing to use an unverified ONNX Runtime DLL.
If the pin changed, move OnnxRuntimeUrl, ortEntryPath, OnnxRuntimeDllSha256
and OnnxRuntimeDllSize together.
"@
    }

    $ortDllSize = (Get-Item -Path $ortDestination).Length
    if ($ortDllSize -ne $OnnxRuntimeDllSize) {
        throw "Unexpected $OnnxRuntimeDll size: $ortDllSize bytes (expected $OnnxRuntimeDllSize). Move OnnxRuntimeUrl, ortEntryPath, OnnxRuntimeDllSha256 and OnnxRuntimeDllSize together if the pin changed."
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

    $expectedOutputs = @($RuntimeDlls + $OnnxRuntimeDll + ($ImportLibs | ForEach-Object { $_.Lib }))
    $missingOutputs = $expectedOutputs |
        Where-Object { -not (Test-Path -Path (Join-Path $resolvedOutDir $_)) }
    if ($missingOutputs) {
        throw ("Missing expected output(s): " + ($missingOutputs -join ", "))
    }

    Write-Host ""
    Write-Host "Indigo $IndigoVersion + ONNX Runtime $OnnxRuntimeVersion Windows runtime ready in $resolvedOutDir"
    Get-ChildItem -Path $resolvedOutDir | Select-Object Name, Length | Format-Table -AutoSize
}
finally {
    Remove-Item -Path $workDir -Recurse -Force -ErrorAction SilentlyContinue
}
