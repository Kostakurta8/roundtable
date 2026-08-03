<#
.SYNOPSIS
  Puts a "Claude Agents" shortcut on the Desktop.

.DESCRIPTION
  Points at desktop\claude-agents.ps1 in this checkout, with the generated icon. Re-running it
  overwrites the existing shortcut, so this is also how you repair one after moving the project.

  Run it directly, or `npm run desktop`, which regenerates the icon first.
#>

$ErrorActionPreference = 'Stop'

$Repo = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $Repo 'desktop\claude-agents.ps1'
$Icon = Join-Path $Repo 'desktop\claude-agents.ico'
$Desktop = [Environment]::GetFolderPath('Desktop')
$Link = Join-Path $Desktop 'Claude Agents.lnk'

foreach ($required in @($Launcher, $Icon)) {
  if (-not (Test-Path $required)) {
    throw "Missing $required - run 'npm run desktop' from the project root."
  }
}

# PowerShell 7 (pwsh) if it is installed, else Windows PowerShell. Written without the
# null-conditional operator because this script is itself run by whichever of the two is available,
# and 5.1 does not have it.
#
# The execution alias under WindowsApps is preferred over whatever `Get-Command` resolves to: on a
# Store install that resolves to a *versioned* path under `Program Files\WindowsApps`, which stops
# existing the next time PowerShell updates and takes the shortcut with it.
$alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\pwsh.exe'
$found = Get-Command pwsh -ErrorAction SilentlyContinue
if (Test-Path $alias) { $Shell = $alias }
elseif ($found) { $Shell = $found.Source }
else { $Shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }

$w = New-Object -ComObject WScript.Shell
$s = $w.CreateShortcut($Link)
$s.TargetPath = $Shell
# `-ExecutionPolicy Bypass` applies to this one process only and changes nothing machine-wide — it
# is what lets a script run from a shortcut on a default Windows install. `-NoExit` keeps the window
# open after Claude Code exits, so a session that ends does not take its own transcript off screen.
$s.Arguments = "-NoLogo -NoExit -ExecutionPolicy Bypass -File `"$Launcher`""
$s.WorkingDirectory = $Repo
$s.IconLocation = "$Icon,0"
$s.Description = 'Open Claude Code and the Roundtable observer together'
$s.WindowStyle = 1 # normal
$s.Save()

Write-Host "Created  $Link"
Write-Host "  runs   $Shell -File `"$Launcher`""
Write-Host "  icon   $Icon"
