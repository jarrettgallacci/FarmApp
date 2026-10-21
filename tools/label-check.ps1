# Farm Records - label check
# Compares the label data stored in the Farm Records database with EPA's
# Pesticide Product Label System (PPLS), and writes a report of differences.
# Read-only: it never changes the database.

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$SupabaseUrl = 'https://devmfericqaekxsxxlvj.supabase.co'
$SupabaseKey = 'sb_publishable_y3Cq2gJEZQM-m5QaBIbaRw_ESWiER3k'     # the app's public (publishable) key - same one the website uses
$Here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$Stamp   = Get-Date -Format 'yyyy-MM-dd_HHmm'
$OutDir  = Join-Path $Here "results\$Stamp"
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir 'epa-raw') | Out-Null

Write-Host ''
Write-Host 'Farm Records - label check' -ForegroundColor Cyan
Write-Host 'Sign in with your Farm Records email and password (nothing is saved).'
$Email = Read-Host 'Email'
$SecurePw = Read-Host 'Password' -AsSecureString
$Pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecurePw))

# ---- 1. Sign in and read the products
try {
  $auth = Invoke-RestMethod -Method Post -Uri "$SupabaseUrl/auth/v1/token?grant_type=password" `
    -Headers @{ apikey = $SupabaseKey } -ContentType 'application/json' `
    -Body (@{ email = $Email; password = $Pw } | ConvertTo-Json)
} catch { Write-Host "Sign-in failed: $($_.Exception.Message)" -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }
$Pw = $null
$H = @{ apikey = $SupabaseKey; Authorization = "Bearer $($auth.access_token)" }
$sel = 'chemical_id,name,epa_reg_no,signal_word,restricted_use,active_ingredient,label_version,label_checked,label_source,active'
$chems = Invoke-RestMethod -Uri "$SupabaseUrl/rest/v1/chemicals?select=$sel&epa_reg_no=not.is.null&order=name" -Headers $H
Write-Host "Checking $($chems.Count) product(s) that have an EPA registration number..."

# ---- helpers
function Get-Prop($obj, [string[]]$names) {
  # finds the first property whose name matches (case-insensitive), searching nested objects
  if ($null -eq $obj) { return $null }
  if ($obj -is [System.Collections.IEnumerable] -and -not ($obj -is [string])) {
    foreach ($o in $obj) { $v = Get-Prop $o $names; if ($null -ne $v) { return $v } }
    return $null
  }
  foreach ($p in $obj.PSObject.Properties) {
    foreach ($n in $names) { if ($p.Name -ieq $n) { return $p.Value } }
  }
  foreach ($p in $obj.PSObject.Properties) {
    if ($p.Value -is [psobject] -or ($p.Value -is [System.Collections.IEnumerable] -and -not ($p.Value -is [string]))) {
      $v = Get-Prop $p.Value $names; if ($null -ne $v) { return $v }
    }
  }
  return $null
}
function Get-AllDates($obj) {
  # every date-looking value in properties whose name mentions "date" inside a PDF list
  $out = @()
  $json = $obj | ConvertTo-Json -Depth 20 -Compress
  foreach ($m in [regex]::Matches($json, '"(pdf[^"]*date[^"]*|[^"]*accept[^"]*date[^"]*)"\s*:\s*"([^"]+)"', 'IgnoreCase')) {
    $d = $null
    if ([datetime]::TryParse($m.Groups[2].Value, [ref]$d)) { $out += $d }
  }
  return $out
}
function Norm($s) { if ($null -eq $s) { return '' } ; return ($s.ToString().Trim().ToUpper() -replace '\s+', ' ') }
function BaseReg([string]$reg) {
  # 100-497-5905 (distributor product) -> 100-497 ; pad to 000100-00497
  $parts = $reg.Trim() -split '-'
  if ($parts.Count -lt 2) { return $null }
  return ('{0:D6}-{1:D5}' -f [int]$parts[0], [int]$parts[1])
}

# ---- 2. Look each product up at EPA and compare
$rows = @()
foreach ($c in $chems) {
  $base = BaseReg $c.epa_reg_no
  $row = [ordered]@{ Product = $c.name; Reg = $c.epa_reg_no; Issues = @(); Info = @(); Latest = ''; EpaName = ''; Link = "https://ordspub.epa.gov/ords/pesticides/f?p=PPLS:102:::NO::P102_REG_NUM:$($c.epa_reg_no)" }
  if (-not $base) { $row.Issues += 'EPA number is not in the usual 123-456 form'; $rows += [pscustomobject]$row; continue }
  Write-Host "  $($c.name) ($($c.epa_reg_no))"
  $epa = $null
  foreach ($u in @("https://ordspub.epa.gov/ords/pesticides/cswu/ppls/$base", "https://ordspub.epa.gov/ords/pesticides/ppls/$base")) {
    try { $epa = Invoke-RestMethod -Uri $u -TimeoutSec 60; if ($epa) { break } } catch { $err = $_.Exception.Message }
  }
  if (-not $epa) { $row.Issues += "Couldn't read EPA's record ($err)"; $rows += [pscustomobject]$row; continue }
  $epa | ConvertTo-Json -Depth 20 | Set-Content -Encoding UTF8 (Join-Path $OutDir ("epa-raw\" + ($c.epa_reg_no -replace '[^\w-]', '_') + '.json'))

  $row.EpaName = Get-Prop $epa @('productname', 'product_name', 'prodname')
  $status = Get-Prop $epa @('product_status', 'productstatus', 'status')
  $signal = Get-Prop $epa @('signal_word', 'signalword')
  $rup    = Get-Prop $epa @('rupyn', 'rup_yn', 'rup', 'restricted_use')
  $dates  = Get-AllDates $epa
  if ($dates.Count) { $latest = ($dates | Sort-Object | Select-Object -Last 1); $row.Latest = $latest.ToString('yyyy-MM-dd') }

  if ($status -and (Norm $status) -notmatch 'ACTIVE|REGISTERED') { $row.Issues += "EPA status is '$status'" }
  if ($signal -and $c.signal_word -and (Norm $signal) -ne (Norm $c.signal_word)) { $row.Issues += "Signal word: EPA says '$signal', database has '$($c.signal_word)'" }
  if ($signal -and -not $c.signal_word) { $row.Info += "EPA signal word '$signal' (not recorded in database)" }
  if ($null -ne $rup -and "$rup" -ne '') {
    $epaRup = (Norm $rup) -match '^(Y|YES|TRUE|1)'
    if ($epaRup -ne [bool]$c.restricted_use) { $row.Issues += "Restricted use: EPA says $(if ($epaRup) {'yes'} else {'no'}), database says $(if ($c.restricted_use) {'yes'} else {'no'})" }
  }
  if ($row.Latest) {
    if (-not $c.label_version) { $row.Info += "Newest EPA-accepted label: $($row.Latest). No label version recorded in the database yet." }
    else {
      $have = $null
      if ([datetime]::TryParse($c.label_version, [ref]$have) -and $have -lt [datetime]$row.Latest) {
        $row.Issues += "Newer label at EPA ($($row.Latest)) than the version in the database ($($c.label_version)) - check the plant-back intervals"
      }
    }
  } else { $row.Info += "Couldn't find label dates in EPA's record (see the raw file)" }
  if (-not $c.label_checked -and $c.label_source) { $row.Info += 'Label data in the database has not been checked yet' }
  $rows += [pscustomobject]$row
}

# ---- 3. Report
$flagged = @($rows | Where-Object { $_.Issues.Count })
$enc = { param($s) [System.Net.WebUtility]::HtmlEncode("$s") }
$html = @"
<!doctype html><html><head><meta charset="utf-8"><title>Label check $Stamp</title>
<style>body{font:15px system-ui,Segoe UI,sans-serif;margin:24px;color:#1a2b3d;background:#f3f7fc}
h1{font-size:20px} table{border-collapse:collapse;width:100%;background:#fff} th,td{padding:8px;border-bottom:1px solid #dde6f1;text-align:left;vertical-align:top}
th{font-size:12px;text-transform:uppercase;color:#627389} .bad{color:#b91c1c} .ok{color:#1f7a4d} .muted{color:#627389;font-size:13px}</style></head><body>
<h1>Label check - $(Get-Date -Format 'MMMM d, yyyy h:mm tt')</h1>
<p>$($rows.Count) product(s) checked against EPA. <b class="$(if ($flagged.Count) {'bad'} else {'ok'})">$($flagged.Count) with differences.</b></p>
<p class="muted">EPA's database shows EPA-accepted labels. The label on your container and Washington 24(c) labels can differ. Plant-back intervals can't be compared automatically - when a newer label shows up, bring that PDF to Claude.</p>
<table><tr><th>Product</th><th>EPA reg.</th><th>Newest EPA label</th><th>Differences</th><th>Notes</th></tr>
$(($rows | Sort-Object { -$_.Issues.Count }, Product | ForEach-Object {
  "<tr><td><b>$(& $enc $_.Product)</b>$(if ($_.EpaName) {"<div class='muted'>EPA: $(& $enc $_.EpaName)</div>"})</td><td><a href='$($_.Link)'>$(& $enc $_.Reg)</a></td><td>$(& $enc $_.Latest)</td>" +
  "<td class='bad'>$((($_.Issues | ForEach-Object { & $enc $_ }) -join '<br>'))</td><td class='muted'>$((($_.Info | ForEach-Object { & $enc $_ }) -join '<br>'))</td></tr>"
}) -join "`n")
</table></body></html>
"@
$report = Join-Path $OutDir 'label-check-report.html'
$html | Set-Content -Encoding UTF8 $report
$rows | Select-Object Product, Reg, Latest, EpaName, @{n='Differences';e={$_.Issues -join ' | '}}, @{n='Notes';e={$_.Info -join ' | '}} |
  Export-Csv -NoTypeInformation -Encoding UTF8 (Join-Path $OutDir 'label-check-report.csv')

Write-Host ''
Write-Host "Done. $($flagged.Count) product(s) with differences." -ForegroundColor $(if ($flagged.Count) { 'Yellow' } else { 'Green' })
Write-Host "Report: $report"
Start-Process $report
Read-Host 'Press Enter to close'
