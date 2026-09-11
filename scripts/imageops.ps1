# imageops.ps1 — image operations the see-screen toolbox needs, kept out of the
# plugin so they can be run and verified standalone.
#
# Modes:
#   diff        compare two images, locate changed regions, write paired crops
#   storage     report (and optionally prune) the DSH attachment store
#   calib-draw  draw a calibration image whose every fact is known by construction
#   calib-bad   apply a known set of changes to a calibration image
#
# Output is line-oriented KEY=VALUE, like capture.ps1.
# EXIT CODE CONTRACT: like capture.ps1 this script ALWAYS exits 0. Failure is
# reported only through an ERR= line, so a caller that checks only the exit code
# will mistake every failure for success. Parse ERR=.

param(
  [Parameter(Mandatory = $true)][string]$Mode,
  [string]$A = '',
  [string]$B = '',
  [string]$OutDir = '',
  [string]$Out = '',
  [int]$GridW = 64,
  [int]$GridH = 36,
  [int]$CellMinPixels = 12,
  [int]$PixelThreshold = 24,
  [int]$MaxRegions = 8,
  [int]$Dilate = 1,
  [int]$Keep = 4,
  [int]$Padding = 10,
  [int]$PruneDays = 0,
  [switch]$AlsoFullPair,
  [switch]$DumpGrid
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing

function Fail($message) {
  Write-Output ('ERR=' + $message)
  exit 0
}

# All plugin images live in one folder so a human can find them and so retention has
# a single place to act. Never %TEMP%: that hides them among unrelated files.
function Get-VisionDir {
  $h = $env:DSH_HOME
  if ([string]::IsNullOrWhiteSpace($h)) { $h = Join-Path $env:USERPROFILE '.dsh' }
  $d = Join-Path $h 'vision'
  if (-not (Test-Path -LiteralPath $d)) { [void](New-Item -ItemType Directory -Path $d -Force) }
  return $d
}

# Keep the folder small: retain the newest $Keep unpinned files, never delete a file
# written by the current invocation (the caller has not read those yet), and report
# what went.
#
# Files named `keep_*` are PINNED and are not counted or deleted. Without that rule a
# pure mtime policy deletes whatever happens to be oldest, which is exactly how it
# destroyed the one non-regenerable sample it was supposed to preserve. Pinning costs
# nothing and needs no extra state: rename the image you care about.
function Invoke-VisionPrune($dir, $keep, $protect) {
  $all = @(Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
  $candidates = @($all | Where-Object { $_.Name -notlike 'keep_*' })
  $floor = [math]::Max($keep, @($protect).Count)
  if ($candidates.Count -le $floor) { return @() }
  $gone = New-Object System.Collections.ArrayList
  for ($i = $floor; $i -lt $candidates.Count; $i++) {
    if (@($protect) -contains $candidates[$i].FullName) { continue }
    Remove-Item -LiteralPath $candidates[$i].FullName -Force -ErrorAction SilentlyContinue
    [void]$gone.Add($candidates[$i].Name)
  }
  return $gone.ToArray()
}

# The pixel loop lives in C# on purpose: 1M+ pixels through PowerShell's
# GetPixel is seconds of wall clock, and LockBits + a native loop is milliseconds.
$csharp = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public class DshImageOps
{
    // counts[cy*gridW+cx] = number of pixels in that cell whose max channel delta
    // exceeded threshold. Both bitmaps must already be the same size.
    public static int[] DiffGrid(Bitmap a, Bitmap b, int gridW, int gridH, int threshold)
    {
        int w = a.Width, h = a.Height;
        var counts = new int[gridW * gridH];
        BitmapData da = a.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        BitmapData db = b.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            int strideA = da.Stride, strideB = db.Stride;
            byte[] ba = new byte[strideA * h];
            byte[] bb = new byte[strideB * h];
            Marshal.Copy(da.Scan0, ba, 0, ba.Length);
            Marshal.Copy(db.Scan0, bb, 0, bb.Length);
            for (int y = 0; y < h; y++)
            {
                int cy = (int)((long)y * gridH / h);
                if (cy >= gridH) cy = gridH - 1;
                int rowA = y * strideA, rowB = y * strideB;
                int cellRow = cy * gridW;
                for (int x = 0; x < w; x++)
                {
                    int iA = rowA + x * 4, iB = rowB + x * 4;
                    int d = ba[iA] - bb[iB]; if (d < 0) d = -d;
                    int d2 = ba[iA + 1] - bb[iB + 1]; if (d2 < 0) d2 = -d2;
                    int d3 = ba[iA + 2] - bb[iB + 2]; if (d3 < 0) d3 = -d3;
                    if (d2 > d) d = d2;
                    if (d3 > d) d = d3;
                    if (d > threshold)
                    {
                        int cx = (int)((long)x * gridW / w);
                        if (cx >= gridW) cx = gridW - 1;
                        counts[cellRow + cx]++;
                    }
                }
            }
        }
        finally
        {
            a.UnlockBits(da);
            b.UnlockBits(db);
        }
        return counts;
    }
}
'@
$ops = Add-Type -TypeDefinition $csharp -ReferencedAssemblies System.Drawing -PassThru

function Load-Bitmap([string]$path) {
  if ([string]::IsNullOrWhiteSpace($path)) { Fail 'a path argument is missing' }
  if (-not (Test-Path -LiteralPath $path)) { Fail ('file not found: ' + $path) }
  # Copy through a MemoryStream so the file handle is released immediately.
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $ms = New-Object System.IO.MemoryStream(, $bytes)
  $img = [System.Drawing.Image]::FromStream($ms)
  $bmp = New-Object System.Drawing.Bitmap($img)
  $img.Dispose()
  $ms.Dispose()
  return $bmp
}

function New-LabeledFont([int]$size) {
  return New-Object System.Drawing.Font('Consolas', $size, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
}

# ---------------------------------------------------------------------------
# diff
# ---------------------------------------------------------------------------

if ($Mode -eq 'diff') {
  $imgA = Load-Bitmap $A
  $imgB = Load-Bitmap $B

  if ($imgA.Width -ne $imgB.Width -or $imgA.Height -ne $imgB.Height) {
    # Scale B onto A's canvas so the two are comparable. Reported, never silent.
    $tmp = New-Object System.Drawing.Bitmap($imgA.Width, $imgA.Height)
    $tg = [System.Drawing.Graphics]::FromImage($tmp)
    $tg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $tg.DrawImage($imgB, 0, 0, $imgA.Width, $imgA.Height)
    $tg.Dispose()
    $imgB.Dispose()
    $imgB = $tmp
    Write-Output ('NOTE=size mismatch, B was rescaled onto A')
  }

  $w = $imgA.Width
  $h = $imgA.Height
  $counts = $ops::DiffGrid($imgA, $imgB, $GridW, $GridH, $PixelThreshold)

  # Cells above the per-cell floor, then connected components (4-neighbourhood).
  $marked = New-Object 'bool[]' ($GridW * $GridH)
  $totalChanged = 0
  for ($i = 0; $i -lt $counts.Length; $i++) {
    $totalChanged += $counts[$i]
    if ($counts[$i] -ge $CellMinPixels) { $marked[$i] = $true }
  }

  # Grow the marked cells before labelling. Without this a single changed character
  # fragmenting into several cells, and a moved object counting as two separate
  # regions (old position + new position), turn one conceptual change into many
  # regions and the top-N truncation then drops the important ones.
  if ($Dilate -gt 0) {
    $grown = New-Object 'bool[]' ($GridW * $GridH)
    for ($i = 0; $i -lt $marked.Length; $i++) {
      if (-not $marked[$i]) { continue }
      $cy = [int][math]::Floor($i / $GridW)
      $cx = $i - $cy * $GridW
      for ($dy = -$Dilate; $dy -le $Dilate; $dy++) {
        for ($dx = -$Dilate; $dx -le $Dilate; $dx++) {
          $nx = $cx + $dx
          $ny = $cy + $dy
          if ($nx -lt 0 -or $ny -lt 0 -or $nx -ge $GridW -or $ny -ge $GridH) { continue }
          $grown[$ny * $GridW + $nx] = $true
        }
      }
    }
    $marked = $grown
  }

  $regions = New-Object System.Collections.ArrayList
  $seen = New-Object 'bool[]' ($GridW * $GridH)
  # 4-neighbour offsets, kept as two arrays so indexing them is unambiguous.
  $stepX = @(1, -1, 0, 0)
  $stepY = @(0, 0, 1, -1)
  for ($i = 0; $i -lt $marked.Length; $i++) {
    if (-not $marked[$i] -or $seen[$i]) { continue }
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($i)
    $seen[$i] = $true
    $minX = $GridW; $minY = $GridH; $maxX = -1; $maxY = -1; $pixels = 0
    while ($queue.Count -gt 0) {
      $cur = $queue.Dequeue()
      # PowerShell's [int] cast ROUNDS, it does not truncate: [int](2272/64) is 36, not 35.
      # A plain [int]($cur / $GridW) therefore mapped every cell in the right half of the
      # LAST grid row onto a phantom row past the end, which shattered one changed blob
      # into one component per column and gave every region wrong bounds.
      $cy = [int][math]::Floor($cur / $GridW)
      $cx = $cur - $cy * $GridW
      if ($cx -lt $minX) { $minX = $cx }
      if ($cy -lt $minY) { $minY = $cy }
      if ($cx -gt $maxX) { $maxX = $cx }
      if ($cy -gt $maxY) { $maxY = $cy }
      $pixels += $counts[$cur]
      for ($k = 0; $k -lt 4; $k++) {
        $nx = $cx + $stepX[$k]
        $ny = $cy + $stepY[$k]
        if ($nx -lt 0 -or $ny -lt 0 -or $nx -ge $GridW -or $ny -ge $GridH) { continue }
        $ni = $ny * $GridW + $nx
        if ($marked[$ni] -and -not $seen[$ni]) { $seen[$ni] = $true; $queue.Enqueue($ni) }
      }
    }
    [void]$regions.Add([pscustomobject]@{
      MinX = $minX; MinY = $minY; MaxX = $maxX; MaxY = $maxY; Pixels = $pixels
    })
  }

  Write-Output ('SIZE=' + $w + 'x' + $h)
  Write-Output ('GRID=' + $GridW + 'x' + $GridH)
  Write-Output ('PIXELTHRESHOLD=' + $PixelThreshold)
  Write-Output ('CHANGEDPIXELS=' + $totalChanged)
  $pct = if ($w * $h -gt 0) { [math]::Round(100.0 * $totalChanged / ($w * $h), 3) } else { 0 }
  Write-Output ('CHANGEDPCT=' + $pct)
  Write-Output ('REGIONCOUNT=' + $regions.Count)

  # Cell-space bounds for every component. Two 4-connected components can never
  # share a cell, so overlapping cell bounding boxes would prove the labelling is
  # wrong -- which is exactly what the pixel-space output could not tell apart.
  foreach ($r in $regions) {
    Write-Output ('CELLREGION=' + $r.MinX + '|' + $r.MinY + '|' + $r.MaxX + '|' + $r.MaxY + '|' + $r.Pixels)
  }
  if ($DumpGrid) {
    for ($ry = 0; $ry -lt $GridH; $ry++) {
      $line = ''
      for ($rx = 0; $rx -lt $GridW; $rx++) {
        if ($marked[$ry * $GridW + $rx]) { $line += '#' } else { $line += '.' }
      }
      Write-Output ('GRIDROW=' + $ry.ToString('00') + '|' + $line)
    }
  }

  if ($regions.Count -eq 0) {
    Write-Output 'VERDICT=no region exceeded the per-cell floor; the two images look the same at this threshold'
    $imgA.Dispose(); $imgB.Dispose()
    exit 0
  }

  if ([string]::IsNullOrWhiteSpace($OutDir)) { $OutDir = Get-VisionDir }
  if (-not (Test-Path -LiteralPath $OutDir)) { [void](New-Item -ItemType Directory -Path $OutDir -Force) }

  # Biggest change first: that is what the caller wants described first.
  $ordered = $regions | Sort-Object -Property Pixels -Descending
  $written = New-Object System.Collections.ArrayList
  $index = 0
  foreach ($r in $ordered) {
    if ($index -ge $MaxRegions) { break }
    $x0 = [int][math]::Floor($r.MinX * $w / $GridW) - $Padding
    $y0 = [int][math]::Floor($r.MinY * $h / $GridH) - $Padding
    $x1 = [int][math]::Ceiling(($r.MaxX + 1) * $w / $GridW) + $Padding
    $y1 = [int][math]::Ceiling(($r.MaxY + 1) * $h / $GridH) + $Padding
    if ($x0 -lt 0) { $x0 = 0 }
    if ($y0 -lt 0) { $y0 = 0 }
    if ($x1 -gt $w) { $x1 = $w }
    if ($y1 -gt $h) { $y1 = $h }
    $cw = $x1 - $x0
    $ch = $y1 - $y0
    if ($cw -lt 8 -or $ch -lt 8) { continue }

    $index++
    $rect = New-Object System.Drawing.Rectangle($x0, $y0, $cw, $ch)
    foreach ($pair in @(@('A', $imgA), @('B', $imgB))) {
      $crop = New-Object System.Drawing.Bitmap($cw, $ch)
      $cg = [System.Drawing.Graphics]::FromImage($crop)
      $cg.DrawImage($pair[1], (New-Object System.Drawing.Rectangle(0, 0, $cw, $ch)), $rect, [System.Drawing.GraphicsUnit]::Pixel)
      $cg.Dispose()
      $path = Join-Path $OutDir ('diff' + $index + '_' + $pair[0] + '.png')
      $crop.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
      $crop.Dispose()
      [void]$written.Add($path)
      Write-Output ('CROP' + $pair[0] + '_' + $index + '=' + $path)
    }
    Write-Output ('REGION=' + $index + '|' + $x0 + '|' + $y0 + '|' + $cw + '|' + $ch + '|' + $r.Pixels)
  }

  if ($AlsoFullPair) {
    $fullA = Join-Path $OutDir 'full_A.png'
    $fullB = Join-Path $OutDir 'full_B.png'
    $imgA.Save($fullA, [System.Drawing.Imaging.ImageFormat]::Png)
    $imgB.Save($fullB, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output ('FULLA=' + $fullA)
    Write-Output ('FULLB=' + $fullB)
  }

  # Retention runs AFTER writing and never touches this run's crops: the caller is
  # about to read exactly those. Everything older is fair game.
  $gone = Invoke-VisionPrune $OutDir $Keep $written.ToArray()
  if (@($gone).Count -gt 0) { Write-Output ('PRUNED=' + (@($gone) -join ',')) }
  Write-Output ('OUTDIR=' + $OutDir)
  $imgA.Dispose()
  $imgB.Dispose()
  exit 0
}

# ---------------------------------------------------------------------------
# storage — the DSH attachment store grows one file per vision call and never
# prunes itself. Deleting from it can break image rendering in historical
# sessions, so pruning is opt-in and reported.
# ---------------------------------------------------------------------------

if ($Mode -eq 'storage') {
  $home2 = $env:DSH_HOME
  if ([string]::IsNullOrWhiteSpace($home2)) { $home2 = Join-Path $env:USERPROFILE '.dsh' }
  $root = Join-Path $home2 'attachments'
  Write-Output ('ROOT=' + $root)
  if (-not (Test-Path -LiteralPath $root)) {
    Write-Output 'COUNT=0'
    Write-Output 'BYTES=0'
    exit 0
  }
  $files = @(Get-ChildItem -LiteralPath $root -Recurse -Force -File -ErrorAction SilentlyContinue)
  $sum = ($files | Measure-Object -Property Length -Sum).Sum
  if ($null -eq $sum) { $sum = 0 }
  Write-Output ('COUNT=' + $files.Count)
  Write-Output ('BYTES=' + $sum)
  if ($files.Count -gt 0) {
    $sorted = $files | Sort-Object LastWriteTime
    Write-Output ('OLDEST=' + $sorted[0].LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
    Write-Output ('NEWEST=' + $sorted[$sorted.Count - 1].LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
  }
  if ($PruneDays -gt 0) {
    $cutoff = (Get-Date).AddDays(-$PruneDays)
    $victims = @($files | Where-Object { $_.LastWriteTime -lt $cutoff })
    $vBytes = ($victims | Measure-Object -Property Length -Sum).Sum
    if ($null -eq $vBytes) { $vBytes = 0 }
    foreach ($v in $victims) { Remove-Item -LiteralPath $v.FullName -Force -ErrorAction SilentlyContinue }
    Write-Output ('PRUNEDAYS=' + $PruneDays)
    Write-Output ('DELETED=' + $victims.Count)
    Write-Output ('DELETEDBYTES=' + $vBytes)
  }
  exit 0
}

# ---------------------------------------------------------------------------
# calibration — draw an image whose every fact is known by construction, so the
# vision answer can be scored against ground truth instead of against a feeling.
# ---------------------------------------------------------------------------

if ($Mode -eq 'calib-draw' -or $Mode -eq 'calib-bad') {
  $mutate = ($Mode -eq 'calib-bad')

  $W = 900
  $H = 560
  $bmp = New-Object System.Drawing.Bitmap($W, $H)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::White)

  $black = [System.Drawing.Brushes]::Black
  $titleFont = New-LabeledFont 26
  $smallFont = New-LabeledFont 15
  $axisFont = New-LabeledFont 13

  # 1) exact text facts
  $code = if ($mutate) { 'CAL-7F3B' } else { 'CAL-7F3A' }
  $g.DrawString('CALIBRATION ' + $code, $titleFont, $black, 24, 20)
  $g.DrawString('path: C:\cal\a.b\c-d.txt', $smallFont, $black, 24, 62)
  $g.DrawString('items: 7   checksum: 4391', $smallFont, $black, 24, 88)

  # 2) countable shapes with known colours, in known quadrants
  $red = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220, 40, 40))
  $blue = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(40, 90, 220))
  $green = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(40, 170, 80))
  if ($mutate) {
    # known change A: the red circle moves from top-left to bottom-right
    $g.FillEllipse($red, 660, 420, 90, 90)
  } else {
    $g.FillEllipse($red, 40, 140, 90, 90)
  }
  $g.FillRectangle($blue, 170, 140, 90, 90)
  $g.FillEllipse($green, 300, 140, 90, 90)

  # 3) a bar chart with known values
  $baseY = 400
  $scale = 1.0
  $bars = @(
    @{ x = 470; value = 40;  color = @(60, 120, 230) },
    @{ x = 550; value = 110; color = @(240, 140, 30) },
    @{ x = 630; value = 180; color = @(40, 170, 80) },
    @{ x = 710; value = 160; color = @(140, 70, 200) }
  )
  if ($mutate) {
    # known change 3: bar C drops from 180 to 90 -- BOTH its drawn height and the
    # value printed above it change. The baseline value must match what EXPECTED
    # claims, otherwise the calibration reports a wrong ground truth.
    $bars[2].value = 90
  }
  $axisPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(70, 70, 70), 2)
  $g.DrawLine($axisPen, 450, $baseY, 810, $baseY)
  $g.DrawLine($axisPen, 450, $baseY, 450, 200)
  for ($i = 0; $i -lt $bars.Length; $i++) {
    $barH = [int]($bars[$i].value * 1.6)
    $c = $bars[$i].color
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($c[0], $c[1], $c[2]))
    $g.FillRectangle($brush, $bars[$i].x, ($baseY - $barH), 58, $barH)
    # The value is printed above its own bar, so the number and the height always
    # agree -- no decorative axis labels that could contradict the drawing.
    $g.DrawString([string]$bars[$i].value, $axisFont, $black, $bars[$i].x, ($baseY - $barH - 20))
    $g.DrawString(('ABCD'[$i]), $axisFont, $black, ($bars[$i].x + 22), ($baseY + 4))
  }

  # 4) a yellow band across the bottom, present only in the original
  if (-not $mutate) {
    $yellow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(250, 200, 0))
    $g.FillRectangle($yellow, 0, ($H - 40), $W, 40)
  }

  $g.Dispose()

  if ([string]::IsNullOrWhiteSpace($Out)) {
    if ($mutate) { $Out = Join-Path (Get-VisionDir) 'calib-mutated.png' } else { $Out = Join-Path (Get-VisionDir) 'calib-baseline.png' }
  }
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()

  $gone = Invoke-VisionPrune (Get-VisionDir) $Keep @($Out)
  if (@($gone).Count -gt 0) { Write-Output ('PRUNED=' + (@($gone) -join ',')) }

  Write-Output ('PATH=' + $Out)
  Write-Output ('SIZE=' + $W + 'x' + $H)
  if ($mutate) {
    Write-Output 'EXPECTED=1|title text changed from CALIBRATION CAL-7F3A to CALIBRATION CAL-7F3B'
    Write-Output 'EXPECTED=2|the red circle moved from the upper-left area to the lower-right corner'
    Write-Output 'EXPECTED=3|bar C dropped from 180 to 90 -- both its height and the value printed above it changed'
    Write-Output 'EXPECTED=4|the yellow band along the bottom edge disappeared'
    Write-Output 'EXPECTEDCOUNT=4'
  } else {
    Write-Output 'EXPECTED=baseline image drawn; every fact in it is known by construction'
    Write-Output 'EXPECTEDCOUNT=0'
  }
  exit 0
}

# Standalone retention pass, for when the folder has grown without a diff or a
# calibration run to trigger it.
if ($Mode -eq 'prune') {
  $d = Get-VisionDir
  $gone = Invoke-VisionPrune $d $Keep @()
  Write-Output ('DIR=' + $d)
  Write-Output ('KEEP=' + $Keep)
  Write-Output ('PRUNEDCOUNT=' + @($gone).Count)
  if (@($gone).Count -gt 0) { Write-Output ('PRUNEDFILES=' + (@($gone) -join ',')) }
  Write-Output ('REMAINING=' + (@(Get-ChildItem -LiteralPath $d -File -ErrorAction SilentlyContinue).Count))
  exit 0
}

Fail ('unknown mode: ' + $Mode)
