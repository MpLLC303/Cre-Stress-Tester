# Windows setup: create venv, install deps, register daily 6 AM Task Scheduler job, run once.
# Usage (PowerShell from project root): powershell -ExecutionPolicy Bypass -File scripts\setup_windows.ps1

$ErrorActionPreference = "Stop"
$Project = (Resolve-Path "$PSScriptRoot\..").Path
$Venv = Join-Path $Project ".venv"
$Py = Join-Path $Venv "Scripts\python.exe"

Write-Host "► project root: $Project"

if (-Not (Test-Path $Py)) {
    Write-Host "► creating venv"
    python -m venv $Venv
}
Write-Host "► installing requirements"
& "$Venv\Scripts\pip.exe" install --quiet --upgrade pip
& "$Venv\Scripts\pip.exe" install --quiet -r (Join-Path $Project "requirements.txt")

$XmlPath = Join-Path $env:TEMP "LotteryDashboard.xml"
$Xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Colorado Lottery scratch dashboard daily refresh</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-01-01T06:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$Py</Command>
      <Arguments>$Project\scraper.py</Arguments>
      <WorkingDirectory>$Project</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
[System.IO.File]::WriteAllText($XmlPath, $Xml, [System.Text.Encoding]::Unicode)

schtasks /delete /tn LotteryDashboard /f 2>$null | Out-Null
schtasks /create /tn LotteryDashboard /xml $XmlPath
Write-Host "► task registered. Verify: schtasks /query /tn LotteryDashboard"

Write-Host "► running scraper once now"
& $Py (Join-Path $Project "scraper.py")
Write-Host "► done. Open: $Project\index.html"
