<#
.SYNOPSIS
  Opens Claude Code and the Roundtable observer together.

.DESCRIPTION
  What the desktop shortcut runs. Three things, in the order that makes them useful:

    1. Start the observer's two servers, unless they are already up.
    2. Open the room in the browser once it is actually answering.
    3. Bring Claude Code up to date, then hand this window over to it.

  Clicking the icon twice is safe: the servers are only started when nothing is listening, so a
  second click just opens another browser tab and another Claude session.

  The observer is read-only. It watches the transcript files Claude Code already writes under
  ~/.claude and never writes to them.
#>

param(
  # Does everything except hand the window to Claude Code. For checking the shortcut works without
  # spending a session on it.
  [switch]$SkipClaude
)

$ErrorActionPreference = 'Stop'

# The repo is the folder above this script, so moving or renaming the checkout does not break the
# shortcut as long as the two travel together.
$Repo = Split-Path -Parent $PSScriptRoot
$Url = 'http://localhost:5173'
$HubPort = 7411
$WebPort = 5173

# Where the Claude session starts. Home by default: it is where sessions normally run, and so it is
# the slug the observer opens on. Change it if you mostly work somewhere else.
$StartIn = $env:USERPROFILE

function Test-Port([int]$Port) {
  $null -ne (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Write-Step([string]$Text) {
  Write-Host ''
  Write-Host "  $Text" -ForegroundColor Cyan
}

Write-Host ''
Write-Host '  ROUNDTABLE  ·  Claude Agents' -ForegroundColor White
Write-Host '  ---------------------------' -ForegroundColor DarkGray

# --------------------------------------------------------------- the observer

if (-not (Test-Path (Join-Path $Repo 'package.json'))) {
  Write-Host "  Could not find the Roundtable project at $Repo" -ForegroundColor Red
  Write-Host '  The shortcut and the project have to stay together. Re-run scripts\installShortcut.ps1.' -ForegroundColor Red
  Start-Sleep -Seconds 12
  exit 1
}

if ((Test-Port $HubPort) -and (Test-Port $WebPort)) {
  Write-Step 'Roundtable is already running.'
}
else {
  # A half-started pair is worse than neither: the page would load and sit at OFFLINE for ever.
  if ((Test-Port $HubPort) -or (Test-Port $WebPort)) {
    Write-Host ''
    Write-Host "  Port $HubPort or $WebPort is in use but the other is free — something is half-running." -ForegroundColor Yellow
    Write-Host '  Close the other copy and click the icon again.' -ForegroundColor Yellow
  }
  else {
    Write-Step 'Starting Roundtable...'
    # Its own window, minimized and named, so it can be found and closed. `npm run dev` rather than
    # `npm start` because the browser is opened below instead — that way it opens whether or not
    # this click is the one that started the servers.
    Start-Process -FilePath 'cmd.exe' `
      -ArgumentList '/c', "title Roundtable servers && npm run dev" `
      -WorkingDirectory $Repo -WindowStyle Minimized

    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline -and -not ((Test-Port $HubPort) -and (Test-Port $WebPort))) {
      Start-Sleep -Milliseconds 400
    }
  }
}

if ((Test-Port $HubPort) -and (Test-Port $WebPort)) {
  Write-Host "  The room is at $Url" -ForegroundColor DarkGray
  Start-Process $Url
}
else {
  Write-Host '  Roundtable did not come up. Check the "Roundtable servers" window.' -ForegroundColor Yellow
}

# ------------------------------------------------------------- Claude Code

Write-Step 'Checking for a Claude Code update...'
try {
  # Non-fatal on purpose: being offline, or a release that will not install, is no reason to refuse
  # to open the session.
  & claude update 2>&1 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
}
catch {
  Write-Host "  Update skipped: $($_.Exception.Message)" -ForegroundColor DarkGray
}

$version = 'unknown'
try { $version = (& claude --version 2>&1 | Out-String).Trim() } catch { }

if ($SkipClaude) {
  Write-Step "Claude Code $version — would start in $StartIn (-SkipClaude given)"
  Write-Host ''
  exit 0
}

Write-Step "Claude Code $version — starting in $StartIn"
Write-Host ''

Set-Location $StartIn
& claude
