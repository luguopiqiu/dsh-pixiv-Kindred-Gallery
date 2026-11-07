param(
  [string]$Title = 'Download',
  [int]$HoldMs = 0,
  [int]$Tries = 20
)
# Bring an already-opened Explorer window to the foreground.
# The Windows foreground lock rejects plain SetForegroundWindow, so we:
#   1) restore the window if minimized,
#   2) tap ALT to release the lock,
#   3) SetForegroundWindow / BringWindowToTop,
#   4) fall back to AttachThreadInput of the current foreground thread.
$Trace = Join-Path $env:TEMP 'pg-focus-trace.log'
try { Set-Content -LiteralPath $Trace -Value ("start {0:yyyy-MM-dd HH:mm:ss.fff} title={1} tries={2}" -f (Get-Date), $Title, $Tries) -Encoding UTF8 } catch { }
function T([string]$m) {
  try { Add-Content -LiteralPath $Trace -Value ("{0:HH:mm:ss.fff} {1}" -f (Get-Date), $m) -Encoding UTF8 } catch { }
}

$sig = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class PgFocus2 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static List<IntPtr> Find(string title) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var cn = new StringBuilder(256); GetClassName(h, cn, 256);
      if (cn.ToString() != "CabinetWClass") return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      if (string.IsNullOrEmpty(title) || sb.ToString().IndexOf(title, StringComparison.OrdinalIgnoreCase) >= 0) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static IntPtr Any() {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var cn = new StringBuilder(256); GetClassName(h, cn, 256);
      if (cn.ToString() == "CabinetWClass") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool Activate(IntPtr h) {
    if (IsIconic(h)) ShowWindowAsync(h, 9);
    uint pid; uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint me = GetCurrentThreadId();
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    AttachThreadInput(me, fgThread, true);
    BringWindowToTop(h);
    bool ok = SetForegroundWindow(h);
    AttachThreadInput(me, fgThread, false);
    return ok && GetForegroundWindow() == h;
  }
}
"@
try { Add-Type -TypeDefinition $sig -ErrorAction Stop } catch { T ("type-fail: " + $_.Exception.Message); 'type-fail'; exit 1 }
T 'type-ok'

for ($i = 0; $i -lt $Tries; $i++) {
  $hits = @()
  try { $hits = [PgFocus2]::Find($Title) } catch { }
  if ($hits.Count -eq 0) { try { $any = [PgFocus2]::Any(); if ($any -ne [IntPtr]::Zero) { $hits = @($any) } } catch { } }
  T ("try {0} hits={1}" -f $i, $hits.Count)
  foreach ($h in $hits) {
    $ok = $false
    try { $ok = [PgFocus2]::Activate($h) } catch { }
    T ("activate hwnd={0} ok={1}" -f $h, $ok)
    if ($ok) { "raised=1"; exit 0 }
  }
  Start-Sleep -Milliseconds 250
}
T 'give-up'
'raised=0'
exit 0
