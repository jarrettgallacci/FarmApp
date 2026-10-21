# Farm Records - find EPA numbers
# For every active pesticide in the Farm Records chemical list that has no EPA
# registration number yet, searches EPA's Pesticide Product Label System by
# product name and lists the likely matches. Read-only: it never changes the
# database. Bring the results to Claude to confirm the right number for each.

$ErrorActionPreference = 'Stop'
trap {
  $msg = "Unexpected error: $($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))"
  Write-Host $msg -ForegroundColor Red
  try { $msg | Add-Content (Join-Path (Split-Path -Parent $PSCommandPath) 'find-epa-numbers-error.log') } catch {}
  Read-Host 'Press Enter to close'
  exit 1
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$SupabaseUrl = 'https://devmfericqaekxsxxlvj.supabase.co'
$SupabaseKey = 'sb_publishable_y3Cq2gJEZQM-m5QaBIbaRw_ESWiER3k'     # the app's public (publishable) key
$Here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$Stamp  = Get-Date -Format 'yyyy-MM-dd_HHmm'
$OutDir = Join-Path $Here "epa-number-search\$Stamp"
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir 'epa-raw') | Out-Null
$Epa = 'https://ordspub.epa.gov/ords/pesticides'

# EPA sends UTF-8 without saying so; Windows PowerShell would garble (R) and similar.
function GetJson([string]$u) {
  $r = Invoke-WebRequest -Uri $u -TimeoutSec 60 -UseBasicParsing
  $ms = New-Object IO.MemoryStream; $r.RawContentStream.CopyTo($ms)
  return ([Text.Encoding]::UTF8.GetString($ms.ToArray()) | ConvertFrom-Json)
}
function Prop($o, [string[]]$names) {
  foreach ($n in $names) { $p = $o.PSObject.Properties[$n]; if ($p -and "$($p.Value)".Trim()) { return "$($p.Value)".Trim() } }
  return ''
}
function Norm($s) { return (("$s".ToUpper() -replace '[^A-Z0-9 ]', ' ') -replace '\s+', ' ').Trim() }
function BaseReg([string]$reg) {
  $parts = $reg.Trim() -split '-'
  if ($parts.Count -lt 2) { return $null }
  try { return ('{0}-{1}' -f [int]$parts[0], [int]$parts[1]) } catch { return $null }
}

Write-Host ''
Write-Host 'Farm Records - find EPA numbers' -ForegroundColor Cyan
Write-Host 'Sign in with your Farm Records email and password (nothing is saved).'
$Email = Read-Host 'Email'
$SecurePw = Read-Host 'Password' -AsSecureString
$Pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecurePw))
try {
  $auth = Invoke-RestMethod -Method Post -Uri "$SupabaseUrl/auth/v1/token?grant_type=password" `
    -Headers @{ apikey = $SupabaseKey } -ContentType 'application/json' `
    -Body (@{ email = $Email; password = $Pw } | ConvertTo-Json)
} catch { Write-Host "Sign-in failed: $($_.Exception.Message)" -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }
$Pw = $null
$H = @{ apikey = $SupabaseKey; Authorization = "Bearer $($auth.access_token)" }

# Fertilizers, soil amendments and adjuvants are usually not EPA-registered pesticides - skipped.
$types = 'herbicide,insecticide,fungicide,growth_regulator,other'
$chems = @((Invoke-RestMethod -Uri "$SupabaseUrl/rest/v1/chemicals?select=chemical_id,name,type,manufacturer,active_ingredient,active&epa_reg_no=is.null&active=is.true&type=in.($types)&order=type,name" -Headers $H) | ForEach-Object { $_ })
Write-Host "Searching EPA for $($chems.Count) product(s) with no EPA number (fertilizers and adjuvants skipped)..."

# EPA's name search. Several address forms are tried; the first that answers is used for the rest.
$searchForms = @(
  "$Epa/cswu/ProductSearch/partialprodsearch/v2/riname/{0}",
  "$Epa/cswu/ProductSearch/partialprodsearch/riname/{0}",
  "$Epa/cswu/productsearch/partialprodsearch/v2/riname/{0}"
)
$workingForm = $null
$searchLog = @()
function SearchEpa([string]$term) {
  $enc = [uri]::EscapeDataString($term)
  $forms = if ($script:workingForm) { @($script:workingForm) } else { $script:searchForms }
  foreach ($f in $forms) {
    $u = $f -f $enc
    try {
      $r = GetJson $u
      $items = @($r.items)
      if ($null -ne $r.items) { $script:workingForm = $f; $script:searchLog += "OK $u ($($items.Count))"; return $items }
      $script:searchLog += "No items field: $u"
    } catch { $script:searchLog += "FAILED $u : $($_.Exception.Message)" }
  }
  return
}

$detailCache = @{}
function Detail([string]$base) {
  if ($detailCache.ContainsKey($base)) { return $detailCache[$base] }
  $d = $null
  try { $r = GetJson "$Epa/cswu/ppls/$base"; if ($r.items -and @($r.items).Count) { $d = @($r.items)[0] } } catch {}
  $detailCache[$base] = $d
  return $d
}

$rows = @()
$n = 0
foreach ($c in $chems) {
  $n++
  Write-Host ("  [{0}/{1}] {2}" -f $n, $chems.Count, $c.name)
  $safe = ($c.name -replace '[^\w-]', '_')
  try {
    # Search the full name, then shorter versions ("Dual II Magnum" -> "Dual II" -> "Dual").
    $words = @((Norm $c.name) -split ' ' | Where-Object { $_ })
    $terms = @()
    for ($k = $words.Count; $k -ge 1; $k--) { $t = ($words[0..($k - 1)] -join ' '); if ($t.Length -ge 3) { $terms += $t } }
    if (-not $terms.Count) { $terms = @($c.name) }
    $found = @(); $usedTerm = ''
    foreach ($t in ($terms | Select-Object -First 3)) {
      $found = @(SearchEpa $t)
      if ($found.Count) { $usedTerm = $t; break }
    }
    if ($found.Count) { $found | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $OutDir "epa-raw\$safe.json") }

    # One row per registration (EPA can list a product several times).
    $cands = @{}
    foreach ($f in $found) {
      $reg = Prop $f @('eparegno', 'epa_reg_num', 'eparegnumber', 'regnum', 'reg_num', 'registration_number')
      $base = if ($reg) { BaseReg $reg } else { $null }
      if (-not $base -or $cands.ContainsKey($base)) { continue }
      $cands[$base] = [pscustomobject]@{
        Base = $base; Reg = $reg
        Name = Prop $f @('productname', 'product_name', 'prodname', 'name')
        Company = Prop $f @('companyname', 'company_name', 'registrant', 'company')
        Status = Prop $f @('product_status', 'productstatus', 'status')
      }
    }
    $myName = Norm $c.name
    $myCo = Norm $c.manufacturer
    $scored = foreach ($x in $cands.Values) {
      $s = 0
      $en = Norm $x.Name
      if ($en -eq $myName -or $en -eq "$myName HERBICIDE" -or $en -eq "$myName INSECTICIDE" -or $en -eq "$myName FUNGICIDE") { $s += 50 }
      elseif ($en.StartsWith($myName)) { $s += 30 }
      elseif ($usedTerm -and $en.Contains($usedTerm)) { $s += 10 }
      if ($x.Status -match '^(?i)active') { $s += 20 }
      if ($myCo -and $x.Company -and ((Norm $x.Company).Contains(($myCo -split ' ')[0]))) { $s += 15 }
      $x | Add-Member -NotePropertyName Score -NotePropertyValue $s -PassThru
    }
    $top = @($scored | Sort-Object @{e = 'Score'; Descending = $true }, Name | Select-Object -First 6)

    # Fill in details (status, company, other brand names, signal word) for the best few.
    $rank = 0
    foreach ($x in $top) {
      $rank++
      $d = if ($rank -le 3) { Detail $x.Base } else { $null }
      $alt = ''
      if ($d) {
        if (-not $x.Name) { $x.Name = "$($d.productname)" }
        if (-not $x.Status) { $x.Status = "$($d.product_status)" }
        if (-not $x.Company) { $x.Company = Prop $d @('companyname', 'company_name', 'registrant') }
        $alt = (@($d.altbrandnames) | ForEach-Object { Prop $_ @('altbrandname', 'alt_brand_name', 'brandname') } | Where-Object { $_ }) -join '; '
      }
      $ais = if ($d) { (@($d.active_ingredients) | ForEach-Object { "$($_.active_ing) $($_.active_ing_percent)%" }) -join '; ' } else { '' }
      $rows += [pscustomobject][ordered]@{
        ChemicalId = $c.chemical_id; Product = $c.name; Type = $c.type; Manufacturer = $c.manufacturer
        OurActive = $c.active_ingredient; Rank = $rank; EpaReg = $x.Base; EpaName = $x.Name; Company = $x.Company
        Status = $x.Status; Signal = if ($d) { "$($d.signal_word)" } else { '' }; RUP = if ($d) { "$($d.rup_yn)" } else { '' }
        EpaActives = $ais; OtherBrandNames = $alt; SearchedFor = $usedTerm; Score = $x.Score
        Link = "$Epa/f?p=PPLS:102:::NO::P102_REG_NUM:$($x.Base)"
      }
    }
    if (-not $top.Count) {
      $rows += [pscustomobject][ordered]@{
        ChemicalId = $c.chemical_id; Product = $c.name; Type = $c.type; Manufacturer = $c.manufacturer
        OurActive = $c.active_ingredient; Rank = 0; EpaReg = ''; EpaName = 'NO MATCH FOUND'; Company = ''
        Status = ''; Signal = ''; RUP = ''; EpaActives = ''; OtherBrandNames = ''; SearchedFor = ($terms | Select-Object -First 3) -join ' / '; Score = 0; Link = ''
      }
    }
  } catch {
    "$($c.name): $($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber)" | Add-Content (Join-Path $OutDir 'errors.log')
  }
  Start-Sleep -Milliseconds 300   # be polite to EPA's server
}

$searchLog | Set-Content -Encoding UTF8 (Join-Path $OutDir 'search-log.txt')
$csv = Join-Path $OutDir 'epa-number-candidates.csv'
$rows | Export-Csv -NoTypeInformation -Encoding UTF8 $csv

$enc = { param($s) [System.Net.WebUtility]::HtmlEncode("$s") }
$noMatch = @($rows | Where-Object { $_.Rank -eq 0 }).Count
$html = @"
<!doctype html><html><head><meta charset="utf-8"><title>EPA number search $Stamp</title>
<style>body{font:14px system-ui,Segoe UI,sans-serif;margin:24px;color:#1a2b3d;background:#f3f7fc}
h1{font-size:20px} table{border-collapse:collapse;width:100%;background:#fff} th,td{padding:6px 8px;border-bottom:1px solid #dde6f1;text-align:left;vertical-align:top}
th{font-size:12px;text-transform:uppercase;color:#627389} tr.first td{border-top:2px solid #9fb3c8} .muted{color:#627389;font-size:12px} .bad{color:#b91c1c}</style></head><body>
<h1>EPA number search - $(Get-Date -Format 'MMMM d, yyyy h:mm tt')</h1>
<p>$($chems.Count) product(s) searched. $noMatch with no match. Possible matches are listed best first.</p>
<p><b>Next step:</b> in Claude, say <i>review the EPA number search</i>. Nothing has been changed in the database.</p>
<table><tr><th>Our product</th><th>#</th><th>EPA reg.</th><th>EPA product</th><th>Company</th><th>Status</th><th>Actives</th></tr>
$(($rows | ForEach-Object {
  "<tr class='$(if ($_.Rank -le 1) {'first'})'><td>$(if ($_.Rank -le 1) {"<b>$(& $enc $_.Product)</b><div class='muted'>$(& $enc $_.Type) $(& $enc $_.Manufacturer)</div>"})</td><td>$($_.Rank)</td>" +
  "<td>$(if ($_.Link) {"<a href='$($_.Link)'>$(& $enc $_.EpaReg)</a>"})</td><td>$(& $enc $_.EpaName)$(if ($_.OtherBrandNames) {"<div class='muted'>Also sold as: $(& $enc $_.OtherBrandNames)</div>"})</td>" +
  "<td>$(& $enc $_.Company)</td><td class='$(if ($_.Status -and $_.Status -notmatch '^(?i)active') {'bad'})'>$(& $enc $_.Status)</td><td class='muted'>$(& $enc $_.EpaActives)</td></tr>"
}) -join "`n")
</table></body></html>
"@
$report = Join-Path $OutDir 'epa-number-search.html'
$html | Set-Content -Encoding UTF8 $report

Write-Host ''
if (-not $workingForm) {
  Write-Host "EPA's name search didn't answer. Details are in search-log.txt - send that to Claude." -ForegroundColor Yellow
} else {
  Write-Host "Done. $noMatch product(s) with no match." -ForegroundColor Green
}
Write-Host "Report: $report"
Start-Process $report
Read-Host 'Press Enter to close'
