<#
.SYNOPSIS
    One-click release script (PowerShell)

.DESCRIPTION
    Automates:
      1. Read current version and auto-increment
      2. Sync new version to package.json / package-lock.json / jetbrains/gradle.properties
      3. Commit and push jetbrains submodule
      4. Commit and push parent repo (with submodule pointer update)
      5. Create and push v{newVersion} tag

.PARAMETER Version
    Explicit version number (MAJOR.MINOR.PATCH). If omitted, auto-increments patch.

.PARAMETER Major
    Auto-increment major version (e.g. 0.5.3 -> 1.0.0)

.PARAMETER Minor
    Auto-increment minor version (e.g. 0.5.3 -> 0.6.0)

.PARAMETER Patch
    Auto-increment patch version (default, e.g. 0.5.3 -> 0.5.4)

.PARAMETER DryRun
    Preview mode, no write operations

.EXAMPLE
    .\scripts\release.ps1              # 0.5.3 -> 0.5.4
    .\scripts\release.ps1 -Minor       # 0.5.3 -> 0.6.0
    .\scripts\release.ps1 -Major       # 0.5.3 -> 1.0.0
    .\scripts\release.ps1 0.8.0        # explicit version
    .\scripts\release.ps1 -DryRun      # preview mode
#>

param(
    [string]$Version,

    [switch]$Major,
    [switch]$Minor,
    [switch]$Patch,

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# -- Helpers --
function Invoke-Cmd {
    param(
        [string]$Command,
        [string]$Label,
        [string]$WorkingDir = $Root
    )
    if ($DryRun) {
        Write-Host "  [dry-run] $Label" -ForegroundColor DarkGray
        return ''
    }
    Write-Host "  > $Label" -ForegroundColor Cyan
    $prevLocation = Get-Location
    try {
        Set-Location $WorkingDir
        $output = Invoke-Expression "$Command 2>&1" | Out-String
        return $output.Trim()
    } finally {
        Set-Location $prevLocation
    }
}

function Read-CurrentVersion {
    $pkgPath = Join-Path $Root 'package.json'
    $pkgContent = Get-Content $pkgPath -Raw
    if ($pkgContent -match '"version"\s*:\s*"(\d+)\.(\d+)\.(\d+)"') {
        return @{ Raw = $Matches[0]; Major = [int]$Matches[1]; Minor = [int]$Matches[2]; Patch = [int]$Matches[3] }
    }
    throw 'package.json: no valid version found'
}

function Bump-Version {
    param([hashtable]$Current, [string]$Level)
    switch ($Level) {
        'major' { return "$($Current.Major + 1).0.0" }
        'minor' { return "$($Current.Major).$($Current.Minor + 1).0" }
        'patch' { return "$($Current.Major).$($Current.Minor).$($Current.Patch + 1)" }
        default { throw "Unknown bump level: $Level" }
    }
}

# -- Calculate version --
$Root = Split-Path $PSScriptRoot -Parent
$JetbrainsDir = Join-Path $Root 'jetbrains'

$current = Read-CurrentVersion
if ($Version) {
    if ($Version -notmatch '^\d+\.\d+\.\d+$') {
        Write-Error "Invalid version: $Version`nUsage: .\scripts\release.ps1 [-Major|-Minor|-Patch] [version] [-DryRun]"
        exit 1
    }
    $newVersion = $Version
} else {
    $level = if ($Major) { 'major' } elseif ($Minor) { 'minor' } else { 'patch' }
    $newVersion = Bump-Version -Current $current -Level $level
}

$oldVersion = "$($current.Major).$($current.Minor).$($current.Patch)"

Write-Host ""
Write-Host "Release: $oldVersion -> v$newVersion" -ForegroundColor Green
Write-Host ""

# 1. Check clean workspaces
Write-Host "> Checking workspace status..."
$parentStatus = Invoke-Cmd 'git status --porcelain' 'git status (parent)'
if ($parentStatus) {
    Write-Error "`nParent repo has uncommitted changes:`n$parentStatus"
    exit 1
}

$jetbrainsStatus = Invoke-Cmd 'git status --porcelain' 'git status (jetbrains)' $JetbrainsDir
if ($jetbrainsStatus) {
    Write-Error "`nJetbrains submodule has uncommitted changes:`n$jetbrainsStatus"
    exit 1
}

# 2. Sync version
Write-Host "> Syncing version -> $newVersion"
$syncScript = Join-Path $Root 'scripts\release\sync-version.js'
Invoke-Cmd "node `"$syncScript`" $newVersion" 'version:sync'

# 3. Verify version consistency
Write-Host "> Verifying version consistency..."
$verifyScript = Join-Path $Root 'scripts\release\verify-version.js'
Invoke-Cmd "node `"$verifyScript`"" 'verify:version'

# 4. Commit jetbrains submodule
Write-Host "> Committing jetbrains submodule..."
Invoke-Cmd 'git add -A' 'git add (jetbrains)' $JetbrainsDir
$commitMsg = "chore(release): prepare v$newVersion"
Invoke-Cmd "git commit -m `"$commitMsg`"" 'git commit (jetbrains)' $JetbrainsDir
Invoke-Cmd 'git push origin main' 'git push (jetbrains)' $JetbrainsDir

# 5. Commit parent repo (with submodule pointer update)
Write-Host "> Committing parent repo..."
Invoke-Cmd 'git add package.json package-lock.json jetbrains' 'git add (parent)'
Invoke-Cmd "git commit -m `"$commitMsg`"" 'git commit (parent)'
Invoke-Cmd 'git push origin main' 'git push (parent)'

# 6. Create tag and push
Write-Host "> Creating tag v$newVersion..."
Invoke-Cmd "git tag -a v$newVersion -m `"Release v$newVersion`"" 'git tag'
Invoke-Cmd "git push origin v$newVersion" 'git push tag'

Write-Host ""
Write-Host "Done! $oldVersion -> v$newVersion" -ForegroundColor Green
Write-Host ""
