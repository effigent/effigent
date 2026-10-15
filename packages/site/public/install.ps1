<#
  Effigent endpoint installer (Windows). Installs effigentd as a service,
  enrolls this machine with your organization, and adds the Claude Code, Codex and
  Gemini CLI hooks
  to its machine-wide managed settings.

  Run in an elevated PowerShell:
    iwr https://effigent.ai/install.ps1 -OutFile install.ps1; .\install.ps1 -Token eft_...

  Intune (Win32 app) install command:
    powershell.exe -ExecutionPolicy Bypass -File install.ps1 -Token eft_...
  Use a multi-use enrollment token from the console for a fleet.
#>
param(
  [string]$Token = "",
  [string]$Server = "https://api.effigent.ai",
  [string]$Version = "latest",
  [string]$Releases = "https://effigent.ai/releases/effigentd",
  [switch]$Uninstall
)
$ErrorActionPreference = "Stop"
$Dir   = Join-Path $env:ProgramFiles "Effigent"
$Exe   = Join-Path $Dir "effigentd.exe"
$State = Join-Path $env:ProgramData "Effigent"
$Log   = Join-Path $State "events.jsonl"

function Say($m) { Write-Host "==> $m" }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw "Run this from an elevated (Administrator) PowerShell." }

if ($Uninstall) {
  Say "Removing effigentd"
  if (Get-Service effigentd -ErrorAction SilentlyContinue) { Stop-Service effigentd -ErrorAction SilentlyContinue; sc.exe delete effigentd | Out-Null }
  if (Test-Path $Exe) { & $Exe install-hooks --remove; Remove-Item $Exe -Force }
  Write-Host "effigentd removed. Enrollment state kept in $State (delete it to unenroll this machine)."
  exit 0
}

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
if ($Version -eq "latest") { $Version = (Invoke-RestMethod "$Releases/latest").Trim() }
$bin = "effigentd-windows-$arch.exe"

Say "Installing effigentd $Version"
New-Item -ItemType Directory -Force -Path $Dir, $State | Out-Null
$tmp = Join-Path $env:TEMP $bin
Invoke-WebRequest "$Releases/$Version/$bin" -OutFile $tmp -UseBasicParsing
$want = ((Invoke-RestMethod "$Releases/$Version/$bin.sha256") -split '\s+')[0].ToLower()
$got  = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
if ($want -ne $got) { Remove-Item $tmp -Force; throw "effigentd download failed its checksum" }
if (Get-Service effigentd -ErrorAction SilentlyContinue) { Stop-Service effigentd -ErrorAction SilentlyContinue }
Move-Item $tmp $Exe -Force

if (Test-Path (Join-Path $State "endpoint.json")) {
  Say "Already enrolled; keeping the existing enrollment"
} elseif ($Token) {
  Say "Enrolling this machine with $Server"
  & $Exe enroll --server $Server --token $Token --state-dir $State
  if ($LASTEXITCODE -ne 0) { throw "enrollment failed" }
} else {
  throw "-Token is required for the first install (console: Enforcement -> Enroll a machine)"
}

Say "Adding the agent hooks (Claude Code, Codex, Gemini CLI)"
& $Exe install-hooks
if ($LASTEXITCODE -ne 0) { throw "could not update the agents' managed settings" }

Say "Starting the effigentd service"
$svcArgs = "`"$Exe`" --sensor hooks --state-dir `"$State`" --output none --log-file `"$Log`""
if (-not (Get-Service effigentd -ErrorAction SilentlyContinue)) {
  New-Service -Name effigentd -DisplayName "Effigent endpoint agent" -BinaryPathName $svcArgs -StartupType Automatic `
    -Description "Checks AI coding agents' tool calls against your organization's Effigent policy." | Out-Null
} else {
  sc.exe config effigentd binPath= $svcArgs start= auto | Out-Null
}
sc.exe failure effigentd reset= 86400 actions= restart/5000/restart/5000/restart/30000 | Out-Null
Start-Service effigentd
Start-Sleep -Seconds 2
& $Exe status
Write-Host "`nDone. This machine now appears in the console under Enforcement."
