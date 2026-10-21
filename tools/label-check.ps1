# Farm Records - label check
# Compares the label data stored in the Farm Records database with EPA's
# Pesticide Product Label System (PPLS), and writes a report of differences.
# Read-only: it never changes the database.

$ErrorActionPreference = 'Stop'
trap {
  $msg = "Unexpected error: $($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))"
  Write-Host $msg -ForegroundColor Red
  try { $msg | Add-Content (Join-Path (Split-Path -Parent $PSCommandPath) 'label-check-error.log') } catch {}
  Read-Host 'Press Enter to close'
  exit 1
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$SupabaseUrl = 'https://devmfericqaekxsxxlvj.supabase.co'
$SupabaseKey = 'sb_publishable_y3Cq2gJEZQM-m5QaBIbaRw_ESWiER3k'     # the app's public (publishable) key - same one the website uses
$Here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$Stamp   = Get-Date -Format 'yyyy-MM-dd_HHmm'
$OutDir  = Join-Path $Here "results\$Stamp"
$LabelDir = Join-Path $Here 'labels'   # newest EPA label PDFs, one folder per EPA number
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
# EPA sends UTF-8 without saying so; Windows PowerShell would garble (R) and similar.
function GetJson([string]$u) {
  $r = Invoke-WebRequest -Uri $u -TimeoutSec 60 -UseBasicParsing
  $ms = New-Object IO.MemoryStream; $r.RawContentStream.CopyTo($ms)
  return ([Text.Encoding]::UTF8.GetString($ms.ToArray()) | ConvertFrom-Json)
}
function Norm($s) { if ($null -eq $s) { return '' } ; return ($s.ToString().Trim().ToUpper() -replace '\s+', ' ') }
function BaseReg([string]$reg) {
  # 100-497-5905 (distributor product) -> 100-497 ; leading zeros removed (EPA's examples use 241-310)
  $parts = $reg.Trim() -split '-'
  if ($parts.Count -lt 2) { return $null }
  return ('{0}-{1}' -f [int]$parts[0], [int]$parts[1])
}
# ---- 2. Look each product up at EPA and compare
$Inv = [Globalization.CultureInfo]::InvariantCulture
function EpaDate([string]$s, [string]$file) {
  $d = [datetime]::MinValue
  foreach ($f in @('MMMM d, yyyy', 'MMMM dd, yyyy', 'yyyy-MM-dd')) {
    if ([datetime]::TryParseExact("$s".Trim(), $f, $Inv, [Globalization.DateTimeStyles]::None, [ref]$d)) { return $d }
  }
  $m = [regex]::Match("$file", '(\d{8})\.pdf$')
  if ($m.Success) { return [datetime]::ParseExact($m.Groups[1].Value, 'yyyyMMdd', $Inv) }
  return $null
}
$rows = @()
foreach ($c in $chems) {
  $base = BaseReg $c.epa_reg_no
  $row = [ordered]@{ Product = $c.name; Reg = $c.epa_reg_no; Issues = @(); Info = @(); Latest = ''; EpaName = ''; NewPdf = $false; Link = "https://ordspub.epa.gov/ords/pesticides/f?p=PPLS:102:::NO::P102_REG_NUM:$base" }
  try {
    if (-not $base) { throw 'EPA number is not in the usual 123-456 form' }
    Write-Host "  $($c.name) ($($c.epa_reg_no))"
    if (($c.epa_reg_no -split '-').Count -ge 3) { $row.Info += "Distributor number: compared with the main registration $base" }

    $item = $null; $err = 'no record'
    foreach ($u in @("https://ordspub.epa.gov/ords/pesticides/cswu/ppls/$base", "https://ordspub.epa.gov/ords/pesticides/ppls/$base")) {
      try {
        $r = GetJson $u
        if ($r.items -and @($r.items).Count) { $item = @($r.items)[0]; $r | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 (Join-Path $OutDir ("epa-raw\" + ($c.epa_reg_no -replace '[^\w-]', '_') + '.json')); break }
      } catch { $err = $_.Exception.Message }
    }
    if (-not $item) { $row.Issues += "EPA has no record under $base ($err)"; continue }

    $row.EpaName = "$($item.productname)"
    if ("$($item.product_status)" -and "$($item.product_status)" -notmatch '^(?i)active') { $row.Issues += "EPA status is '$($item.product_status)'" }
    if ("$($item.cancel_flag)" -match '^(?i)y') { $row.Issues += "EPA shows this registration as cancelled ($($item.cancellationreason))" }

    $signal = "$($item.signal_word)"
    if ($signal -and $c.signal_word -and (Norm $signal) -ne (Norm $c.signal_word)) { $row.Issues += "Signal word: EPA says '$signal', database has '$($c.signal_word)'" }
    if ($signal -and -not $c.signal_word) { $row.Info += "EPA signal word '$signal' (not in the database)" }

    if ("$($item.rup_yn)") {
      $epaRup = "$($item.rup_yn)" -match '^(?i)y'
      if ($epaRup -ne [bool]$c.restricted_use) { $row.Issues += "Restricted use: EPA says $(if ($epaRup) {'yes'} else {'no'}), database says $(if ($c.restricted_use) {'yes'} else {'no'})" }
    }

    $pdfs = @()
    foreach ($p in @($item.pdffiles)) {
      if (-not $p.pdffile) { continue }
      $d = EpaDate $p.pdffile_accepted_date $p.pdffile
      if ($d) { $pdfs += [pscustomobject]@{ File = "$($p.pdffile)"; Date = $d } }
    }
    $pdfs = @($pdfs | Sort-Object Date)
    if (-not $pdfs.Count) { $row.Info += 'EPA lists no dated label PDFs'; continue }
    $newest = $pdfs[$pdfs.Count - 1]
    $row.Latest = $newest.Date.ToString('yyyy-MM-dd')

    if (-not $c.label_version) { $row.Info += "No label version recorded in the database yet" }
    else {
      $have = [datetime]::MinValue
      if ([datetime]::TryParse("$($c.label_version)", [ref]$have) -and $have -lt $newest.Date) {
        $row.Issues += "Newer label at EPA ($($row.Latest)) than the version in the database ($($c.label_version)) - check the plant-back intervals"
      }
    }

    # Download the newest label PDF (skipped if already downloaded)
    $dir = Join-Path $LabelDir ($c.epa_reg_no -replace '[^\w-]', '_')
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $dest = Join-Path $dir $newest.File
    if (Test-Path $dest) { $row.Info += "Newest label already downloaded" }
    else {
      try {
        Invoke-WebRequest -Uri "https://www3.epa.gov/pesticides/chem_search/ppls/$($newest.File)" -OutFile $dest -TimeoutSec 180 -UseBasicParsing
        $row.Info += "NEW label PDF downloaded ($($newest.File))"; $row.NewPdf = $true
      } catch {
        Remove-Item -ErrorAction SilentlyContinue $dest
        $row.Info += "Couldn't download the label PDF: $($_.Exception.Message)"
      }
    }
    if (-not $c.label_checked -and $c.label_source) { $row.Info += 'Label data in the database has not been checked yet' }
  } catch {
    $row.Issues += "Error while checking: $($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))"
    "$($c.name): $($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber)" | Add-Content (Join-Path $OutDir 'errors.log')
  } finally {
    $rows += [pscustomobject]$row
  }
}

# ---- 3. Report
$flagged = @($rows | Where-Object { $_.Issues.Count })
$newPdfs = @($rows | Where-Object { $_.NewPdf })
$enc = { param($s) [System.Net.WebUtility]::HtmlEncode("$s") }
$html = @"
<!doctype html><html><head><meta charset="utf-8"><title>Label check $Stamp</title>
<style>body{font:15px system-ui,Segoe UI,sans-serif;margin:24px;color:#1a2b3d;background:#f3f7fc}
h1{font-size:20px} table{border-collapse:collapse;width:100%;background:#fff} th,td{padding:8px;border-bottom:1px solid #dde6f1;text-align:left;vertical-align:top}
th{font-size:12px;text-transform:uppercase;color:#627389} .bad{color:#b91c1c} .ok{color:#1f7a4d} .muted{color:#627389;font-size:13px}</style></head><body>
<h1>Label check - $(Get-Date -Format 'MMMM d, yyyy h:mm tt')</h1>
<p>$($rows.Count) product(s) checked against EPA. <b class="$(if ($flagged.Count) {'bad'} else {'ok'})">$($flagged.Count) with differences.</b> $($newPdfs.Count) new label PDF(s) downloaded.</p>
$(if ($newPdfs.Count) { "<p><b>Next step:</b> in Claude, say <i>check the new labels</i>. Claude will read the downloaded PDFs from your Documents folder and compare them with the database.</p>" })
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
