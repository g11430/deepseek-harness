/**
 * Shared no-shell runner for host-native OS integrations.
 * @module @deepseek-ai/dsh-native-command/runner
 */

import { execFile, spawn } from 'node:child_process'
import { basename, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Testable command boundary; native implementations never invoke a shell. */
export type NativeCommandRunner = (
  command: string,
  args: readonly string[],
  signal: AbortSignal,
) => Promise<{ stdout: string; stderr: string }>

/** One command resolved to its executable file name, without directories or extension case. */
function executableName(command: string): string {
  return (command.replace(/\\/gu, '/').split('/').pop() ?? command).toLowerCase()
}

/**
 * Commands whose entire purpose is to put an OS window on screen. Hiding one
 * suppresses the window it exists to show, while still reporting success.
 */
const WINDOW_SHOWING_COMMANDS = new Set(['explorer.exe'])

/** Whether handing this command to Windows with a hidden window is safe. */
export function hidesWindows(command: string): boolean {
  return !WINDOW_SHOWING_COMMANDS.has(executableName(command))
}

/**
 * Detached-launch commands that must own their standard streams. `execFile`
 * captures output through pipes, and the Windows shell rejects a file-manager
 * request whose process was started with redirected stdio: it opens no folder,
 * so `/select` silently degrades to the file manager's default location.
 */
const DETACHED_COMMANDS = WINDOW_SHOWING_COMMANDS

/** Whether this command must be launched without captured or inherited stdio. */
export function launchesDetached(command: string): boolean {
  return DETACHED_COMMANDS.has(executableName(command))
}

/**
 * Put the file manager's own window in front of the application the user just
 * clicked in.
 *
 * `explorer.exe /select,<path>` opens or reuses the right window but does not
 * activate it, so the reveal looks like it did nothing while the window sits
 * behind the caller. Windows refuses a foreground request from a process that
 * does not already own the foreground, and `AppActivate` is subject to that
 * rule; restoring a window this process just minimized is the documented
 * exception, so the helper minimizes and restores the window it found. The
 * program is passed through `-EncodedCommand`, which keeps the policy out of
 * argv quoting for any path or file name.
 *
 * Kept in step with activate-window-policy.mjs, the copy the activation probe
 * imports so it can verify these exact lines rather than a transcription.
 */
const ACTIVATE_WINDOW_POLICY = [
  'param([string]$Folder, [string]$File)',
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$code = @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class DshRevealActivate {',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);',
  '  public static void Activate(IntPtr h) {',
  '    ShowWindow(h, 6);',
  '    System.Threading.Thread.Sleep(250);',
  '    ShowWindow(h, 9);',
  '    BringWindowToTop(h);',
  '    SetForegroundWindow(h);',
  '  }',
  '}',
  '"@',
  'Add-Type -TypeDefinition $code',
  '$shell = New-Object -ComObject Shell.Application',
  '$deadline = (Get-Date).AddSeconds(12)',
  '$fallback = $null',
  'while ((Get-Date) -lt $deadline) {',
  '  foreach ($window in @($shell.Windows())) {',
  '    $url = $window.LocationURL',
  '    if ($url -ne $Folder -and $url -ne "$Folder/") { continue }',
  '    $match = $false',
  '    try {',
  '      $selected = @($window.Document.SelectedItems() | ForEach-Object { $_.Name })',
  '      $match = $selected -contains $File',
  '    } catch { }',
  '    if ($match) {',
  '      [DshRevealActivate]::Activate([IntPtr]$window.HWND)',
  '      exit 0',
  '    }',
  '    if ($null -eq $fallback) { $fallback = [IntPtr]$window.HWND }',
  '  }',
  '  if ($null -ne $fallback) {',
  '    [DshRevealActivate]::Activate($fallback)',
  '    exit 0',
  '  }',
  '  Start-Sleep -Milliseconds 400',
  '}',
  'exit 1',
].join('\n')

/** Whether a child needs the parent's console; the helper is fully detached. */
const DETACHED_CHILD = { detached: true, stdio: 'ignore', windowsHide: true } as const

/**
 * Start the window-activation helper for one revealed path and let it run
 * independently of this process.
 * @param target - absolute Windows path whose folder window should come forward.
 */
export function activateFileManagerWindow(target: string): void {
  const folder = pathToFileURL(dirname(target), { windows: true }).href.replace(/\/$/u, '')
  const name = basename(target)
  const command = `& { ${ACTIVATE_WINDOW_POLICY} } -Folder '${folder.replace(/'/gu, "''")}'`
    + ` -File '${name.replace(/'/gu, "''")}'`
  const encoded = Buffer.from(command, 'utf16le').toString('base64')
  try {
    const helper = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
    ], DETACHED_CHILD)
    helper.once('error', () => {})
    helper.unref()
  } catch {
    // The reveal itself already happened; a window that stays behind the caller
    // is not worth failing the action over.
  }
}

/**
 * Launch one attached command and capture its utf8 output.
 * @param command - executable path or PATH name.
 * @param args - argv (never a shell string).
 * @param signal - caller/connection lifetime; abort terminates the child.
 * @returns captured stdout/stderr on exit 0.
 */
function runAttached(
  command: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { encoding: 'utf8', signal, windowsHide: hidesWindows(command) },
      (error, stdout, stderr) => {
        if (error !== null) {
          const failure = Object.assign(new Error(error.message, { cause: error }), {
            code: error.code,
            stdout,
            stderr,
          })
          reject(failure)
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })
}

/**
 * Launch one windowed shell command detached from this process's stdio, with
 * nobody to observe. The caller cannot learn the exit status, which is what the
 * delegated file-manager handoff already assumed: a shell that hands the request
 * to an existing desktop process exits non-zero on success.
 * @param command - executable path or PATH name.
 * @param args - argv (never a shell string).
 * @param signal - caller/connection lifetime; abort terminates the child.
 * @returns empty captured output once the child is running.
 */
function runDetached(
  command: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('native command aborted before start'))
      return
    }
    const child = spawn(command, [...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    /** Terminate a launched child when its caller's lifetime ends. */
    const onAbort = (): void => { child.kill() }
    child.once('error', reject)
    child.once('spawn', () => {
      signal.removeEventListener('abort', onAbort)
      child.unref()
      resolve({ stdout: '', stderr: '' })
    })
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Run a host command without a shell. Console commands are captured with UTF-8
 * stdio, abort propagation, and a hidden Windows console where a flashing window
 * is noise. The file manager instead launches detached with its own window,
 * because both capture and hiding discard the window it exists to display.
 * @param command - executable path or PATH name.
 * @param args - argv (never a shell string).
 * @param signal - caller/connection lifetime; abort terminates the child.
 * @returns captured stdout/stderr on exit 0.
 */
export const runNativeCommand: NativeCommandRunner = (command, args, signal) =>
  launchesDetached(command) ? runDetached(command, args, signal) : runAttached(command, args, signal)
