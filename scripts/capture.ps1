# capture.ps1 — screen / window capture with optional region crop and change signature.
#
# Extracted from the Cordis plugin so it can be run and verified on its own:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File capture.ps1 -Mode screen -Out C:\temp\x.png
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File capture.ps1 -Mode window -Query blender -Out C:\temp\x.png
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File capture.ps1 -Mode window -Query blender -Region 0.4,0.2,0.5,0.6 -Out C:\temp\x.png
#
# Output is line-oriented KEY=VALUE so the caller can parse it without JSON:
#   SOURCE=<what was captured, in words>   "virtual screen", or "<process> | <window title>"
#   SOURCESIZE=<w>x<h>                     the captured surface, BEFORE any region crop
#   REGION=<x>,<y>,<w>,<h>                 normalized crop spec; this line is OMITTED when no region was used
#   SIZE=<w>x<h>                           the written PNG - what the caller actually receives
#   NONBLACK=<percent of sampled pixels that are not near-black>
#   SIG=<base64 of a SigW x SigH grayscale fingerprint>
#   PATH=<absolute path of the written PNG>
#   ERR=<reason>            (only on failure; nothing else is printed)
#   TARGET=<deprecated alias for SOURCE, description only, no dimensions>
#
# SOURCESIZE and SIZE are deliberately two fields. They used to be one field named
# TARGET that carried both the description and an embedded "1920x1080"-looking string:
# a caller could read that as the image size while the written file was 1190x486.
# SIZE is the only field that describes the artifact; SOURCESIZE describes the source.
#
# EXIT CODE CONTRACT: this script ALWAYS exits 0, including on failure. Failure is
# reported only by an ERR= line, so a caller that inspects only the exit code will
# mistake every failure for success. Parse ERR=.

param(
  [string]$Mode = 'screen',
  [string]$Query = '',
  [string]$Region = '',
  [string]$Out = '',
  [int]$SigW = 40,
  [int]$SigH = 24
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Every image this plugin writes goes into ONE human-findable folder instead of
# %TEMP%, so the user can look at it. %TEMP% was the old default; it hid these files
# among unrelated ones with no clue which tool produced them. (Retention lives in
# imageops.ps1 -Mode prune, not here.)
#
# -Out may be absolute, or a bare file name. A bare name is resolved INSIDE the
# vision folder. It used to be taken literally, which wrote the PNG into whatever
# directory the caller happened to be sitting in, with no extension - so a manual
# `-Out shot1` silently dropped a screenshot into the process CWD, including a git
# working tree where it could then be committed. Absolute paths are honoured
# unchanged, so the documented `-Out C:\temp\x.png` behaves exactly as before.
$visionHome = $env:DSH_HOME
if ([string]::IsNullOrWhiteSpace($visionHome)) { $visionHome = Join-Path $env:USERPROFILE '.dsh' }
$visionDir = Join-Path $visionHome 'vision'

if ([string]::IsNullOrWhiteSpace($Out)) { $Out = 'screen.png' }
if ([System.IO.Path]::IsPathRooted($Out)) {
  $Out = [System.IO.Path]::GetFullPath($Out)
} else {
  $Out = Join-Path $visionDir $Out
}
# GDI+ writes PNG bytes whatever the name says, so a missing extension yields a file
# that nothing opens by double-click.
if ([string]::IsNullOrWhiteSpace([System.IO.Path]::GetExtension($Out))) { $Out = $Out + '.png' }

# Create the parent so an absolute -Out into a not-yet-existing folder works instead
# of throwing under $ErrorActionPreference = 'Stop'.
$outDir = [System.IO.Path]::GetDirectoryName($Out)
if (-not [string]::IsNullOrWhiteSpace($outDir) -and -not (Test-Path -LiteralPath $outDir)) {
  [void](New-Item -ItemType Directory -Path $outDir -Force)
}

function Fail($message) {
  Write-Output ('ERR=' + $message)
  exit 0
}

# Cleanup and dump modes exist so the caller never has to assemble a shell
# command of its own. Both return before System.Drawing is loaded, so teardown
# and the byte fallback stay cheap even on a host where capture is broken.
if ($Mode -eq 'cleanup') {
  if (Test-Path -LiteralPath $Out) {
    Remove-Item -LiteralPath $Out -Force -ErrorAction SilentlyContinue
  }
  Write-Output 'CLEANED'
  exit 0
}

if ($Mode -eq 'dump') {
  if (-not (Test-Path -LiteralPath $Out)) { Fail 'nothing to dump' }
  Write-Output ('B64=' + [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($Out)))
  exit 0
}

# --- DPI awareness -----------------------------------------------------------
#
# This MUST run before anything queries screen metrics, or Windows lies to us.
#
# Measured on this machine: a DPI-unaware powershell.exe reports a 1280x720
# desktop and CopyFromScreen returns a 1280x720 image, while the real display is
# 1920x1080 at 150% scaling. That silently discards 56% of the pixels before the
# image ever reaches the model, and it is the main reason small UI text came back
# unreadable. Setting PER_MONITOR_AWARE_V2 first yields a native 1920x1080 capture
# at no extra model cost.
#
# It also matters for windows: GetWindowRect from a DPI-unaware process returns
# VIRTUALIZED pixels while DwmGetWindowAttribute returns PHYSICAL ones, so the two
# rects are in different coordinate spaces. Fixing awareness puts every rect, every
# region fraction and every captured bitmap in one space.
#
# SetProcessDPIAware() is the fallback for hosts older than Windows 10 1703.
$dpiMode = 'unchanged'
$dpiModern = '[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);'
$dpiLegacy = '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
try {
  $dpiApi = Add-Type -MemberDefinition $dpiModern -Name DshDpiModern -Namespace Dsh -PassThru
  if ($dpiApi::SetProcessDpiAwarenessContext([IntPtr](-4))) { $dpiMode = 'per-monitor-v2' } else { $dpiMode = 'refused' }
} catch {
  try {
    $dpiOld = Add-Type -MemberDefinition $dpiLegacy -Name DshDpiLegacy -Namespace Dsh -PassThru
    if ($dpiOld::SetProcessDPIAware()) { $dpiMode = 'system-legacy' } else { $dpiMode = 'refused' }
  } catch {
    $dpiMode = 'unavailable'
  }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# --- acquire the base bitmap -------------------------------------------------

$source = $null
# What was captured, IN WORDS, plus the dimensions of the captured surface. These are
# deliberately NOT the produced image's size. The two used to share one field named TARGET
# which embedded a string like 1920x1080 while the written PNG could be 1190x486, so anything
# reading that field as an image size read the wrong number.
$sourceDesc = ''
$regionSpec = ''

if ($Mode -eq 'window') {
  if ([string]::IsNullOrWhiteSpace($Query)) { Fail 'window mode needs -Query' }

  # Add-Type -MemberDefinition keeps the C# tiny: no separate .cs file, and the
  # nested RECT struct is resolved inside the generated class.
  #
  # Do NOT pass -UsingNamespace System.Runtime.InteropServices: -MemberDefinition
  # already injects that using, and a second one is a duplicate-using compile
  # error that makes Add-Type fail outright.
  $csharp = @'
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@
  $win = Add-Type -MemberDefinition $csharp -Name DshWinCapture -Namespace Dsh -PassThru

  $needle = '*' + $Query + '*'
  $candidates = @(Get-Process | Where-Object {
    $_.MainWindowHandle -ne 0 -and
    $_.MainWindowTitle -ne '' -and
    ($_.ProcessName -like $needle -or $_.MainWindowTitle -like $needle)
  })

  if ($candidates.Count -eq 0) { Fail ('no window matched ' + $Query) }

  # Prefer a top-level window that is not a tiny helper window.
  $chosen = $null
  foreach ($candidate in $candidates) {
    $probe = New-Object Dsh.DshWinCapture+RECT
    [void][Dsh.DshWinCapture]::GetWindowRect($candidate.MainWindowHandle, [ref]$probe)
    $pw = $probe.Right - $probe.Left
    $ph = $probe.Bottom - $probe.Top
    if ($pw -ge 200 -and $ph -ge 200) { $chosen = $candidate; break }
  }
  if ($null -eq $chosen) { $chosen = $candidates[0] }

  $rect = New-Object Dsh.DshWinCapture+RECT
  [void][Dsh.DshWinCapture]::GetWindowRect($chosen.MainWindowHandle, [ref]$rect)
  $ww = $rect.Right - $rect.Left
  $wh = $rect.Bottom - $rect.Top
  if ($ww -lt 50 -or $wh -lt 50) { Fail 'matched window is too small' }

  $source = New-Object System.Drawing.Bitmap($ww, $wh)
  $graphics = [System.Drawing.Graphics]::FromImage($source)
  $hdc = $graphics.GetHdc()
  # Flag 2 = PW_RENDERFULLCONTENT: required for windows that render through
  # DirectComposition/GPU. Without it many modern windows come back blank.
  $printOk = [Dsh.DshWinCapture]::PrintWindow($chosen.MainWindowHandle, $hdc, 2)
  $graphics.ReleaseHdc($hdc)
  $graphics.Dispose()

  $sourceDesc = $chosen.ProcessName + ' | ' + $chosen.MainWindowTitle
  if (-not $printOk) { $sourceDesc = $sourceDesc + ' | PrintWindow returned false' }
} else {
  $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $source = New-Object System.Drawing.Bitmap($virtual.Width, $virtual.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($source)
  $graphics.CopyFromScreen($virtual.Location, [System.Drawing.Point]::Empty, $virtual.Size)
  $graphics.Dispose()
  $sourceDesc = 'virtual screen'
}

# Dimensions of the surface actually captured, BEFORE any region crop. Emitted as
# SOURCESIZE, separate from SIZE (the produced PNG), so the two cannot be conflated.
$sourceW = $source.Width
$sourceH = $source.Height

# --- optional region crop (normalized 0..1 against the base bitmap) ----------

if (-not [string]::IsNullOrWhiteSpace($Region)) {
  $parts = $Region.Split(',')
  if ($parts.Count -ne 4) {
    $source.Dispose()
    Fail 'region must be x,y,w,h as four normalized numbers'
  }
  $rx = [double]$parts[0]
  $ry = [double]$parts[1]
  $rw = [double]$parts[2]
  $rh = [double]$parts[3]

  $x = [int][math]::Round($source.Width * $rx)
  $y = [int][math]::Round($source.Height * $ry)
  $w = [int][math]::Round($source.Width * $rw)
  $h = [int][math]::Round($source.Height * $rh)

  if ($x -lt 0) { $x = 0 }
  if ($y -lt 0) { $y = 0 }
  if ($x -gt $source.Width - 16) { $x = 0 }
  if ($y -gt $source.Height - 16) { $y = 0 }
  if ($x + $w -gt $source.Width) { $w = $source.Width - $x }
  if ($y + $h -gt $source.Height) { $h = $source.Height - $y }
  if ($w -lt 16 -or $h -lt 16) {
    $source.Dispose()
    Fail 'rounded region is too small'
  }

  $crop = New-Object System.Drawing.Bitmap($w, $h)
  $cg = [System.Drawing.Graphics]::FromImage($crop)
  $srcRect = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
  $dstRect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
  $cg.DrawImage($source, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
  $cg.Dispose()
  $source.Dispose()
  $source = $crop
  # -join, not +: $rx..$rh are [double], and an expression that STARTS with a double
  # makes PowerShell parse a following `+ ','` as numeric addition, which throws
  # "Cannot convert value ',' to type System.Double". The previous code got away with
  # + only because it started from a string.
  $regionSpec = @($rx, $ry, $rw, $rh) -join ','
}

$innerW = $source.Width
$innerH = $source.Height

# --- near-black ratio: a cheap sanity check that a window capture really saw
# --- content rather than an empty surface.

$nonBlack = 0
$total = 0
$stepY = [math]::Max(1, [int]($innerH / 40))
$stepX = [math]::Max(1, [int]($innerW / 40))
for ($yy = 0; $yy -lt $innerH; $yy += $stepY) {
  for ($xx = 0; $xx -lt $innerW; $xx += $stepX) {
    $px = $source.GetPixel($xx, $yy)
    $total++
    if ($px.R -gt 8 -or $px.G -gt 8 -or $px.B -gt 8) { $nonBlack++ }
  }
}
$nonBlackPct = if ($total -gt 0) { [math]::Round(100.0 * $nonBlack / $total, 1) } else { 0 }

# --- change fingerprint ------------------------------------------------------

$thumb = New-Object System.Drawing.Bitmap($source, $SigW, $SigH)
$bytes = [byte[]]::new($SigW * $SigH)
for ($ty = 0; $ty -lt $SigH; $ty++) {
  for ($tx = 0; $tx -lt $SigW; $tx++) {
    $tp = $thumb.GetPixel($tx, $ty)
    $bytes[$ty * $SigW + $tx] = [byte](($tp.R * 299 + $tp.G * 587 + $tp.B * 114) / 1000)
  }
}
$thumb.Dispose()
$sig = [Convert]::ToBase64String($bytes)

$source.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$source.Dispose()

# DEPRECATED ALIAS - kept only so a version mix degrades instead of breaking.
#
# The plugin module that parses this output is loaded once at process start, while
# this script is executed fresh on every call. Right after an upgrade an older module
# can therefore still be reading TARGET=. Emitting it means that window shows a
# slightly plainer line instead of an empty field.
#
# It carries the DESCRIPTION ONLY - never dimensions. Carrying both is exactly what
# this release removed, and re-adding it here would restore the misreading.
Write-Output ('TARGET=' + $sourceDesc)
Write-Output ('SOURCE=' + $sourceDesc)
Write-Output ('SOURCESIZE=' + $sourceW + 'x' + $sourceH)
if ($regionSpec -ne '') { Write-Output ('REGION=' + $regionSpec) }
Write-Output ('SIZE=' + $innerW + 'x' + $innerH)
Write-Output ('NONBLACK=' + $nonBlackPct)
Write-Output ('SIG=' + $sig)
Write-Output ('PATH=' + $Out)
