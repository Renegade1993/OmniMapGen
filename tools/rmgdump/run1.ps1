# run1.ps1 <job file> [timeout seconds]: one engine generation, hidden, with a hard timeout (kills the process).
param([string]$Job, [int]$Timeout = 120)
$rr = "C:\AI Projects\Heroes 3\VCMI\rmgrun"
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "$rr\VCMI_rmg.exe"
$psi.Arguments = "`"$Job`" --deadline $Timeout"
$psi.WorkingDirectory = $rr
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
$q = [System.Diagnostics.Process]::Start($psi)
$errTask = $q.StandardError.ReadToEndAsync()
$outTask = $q.StandardOutput.ReadToEndAsync()
if (-not $q.WaitForExit(($Timeout + 10) * 1000)) { $q.Kill(); "KILLED after $Timeout s" }
$out = $outTask.Result
"exit " + $q.ExitCode
($out -split "`r?`n" | Where-Object { $_ -match "^(OK|FAIL|DONE|DEADLINE|INIT)" }) -join "`n"
