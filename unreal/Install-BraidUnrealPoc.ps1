param(
    [string]$ProjectRoot = "D:\ContractorsShowdown_New"
)

$ErrorActionPreference = "Stop"

$Source = Join-Path $PSScriptRoot "BraidUnrealPoc"
$ProjectFile = Join-Path $ProjectRoot "Contractors_Showdown.uproject"
$PluginsDir = Join-Path $ProjectRoot "Plugins"
$Destination = Join-Path $PluginsDir "BraidUnrealPoc"

if (!(Test-Path -LiteralPath $Source)) {
    throw "Source plugin folder not found: $Source"
}

if (!(Test-Path -LiteralPath $ProjectFile)) {
    throw "Target Unreal project file not found: $ProjectFile"
}

if (!(Test-Path -LiteralPath $PluginsDir)) {
    New-Item -ItemType Directory -Path $PluginsDir | Out-Null
}

if (Test-Path -LiteralPath $Destination) {
    Copy-Item -Path (Join-Path $Source "*") -Destination $Destination -Recurse -Force
    Write-Host "Updated existing plugin: $Destination"
} else {
    Copy-Item -LiteralPath $Source -Destination $PluginsDir -Recurse
    Write-Host "Installed plugin: $Destination"
}

Write-Host ""
Write-Host "If Unreal does not auto-load it, enable 'Braid Unreal PoC' in the Plugins window"
Write-Host "or add this plugin entry to Contractors_Showdown.uproject:"
Write-Host '  { "Name": "BraidUnrealPoc", "Enabled": true }'
Write-Host ""
Write-Host "Then restart the editor and use Tools > Braid Canvas PoC."
