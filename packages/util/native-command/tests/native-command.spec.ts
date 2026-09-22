import { describe, expect, it } from 'vitest'
import { hidesWindows, launchesDetached, runNativeCommand } from '@deepseek-ai/dsh-native-command'

const node = process.execPath

describe('runNativeCommand', () => {
  it('captures utf8 stdout and stderr on exit 0', async () => {
    const result = await runNativeCommand(
      node,
      ['-e', 'process.stdout.write("out✓"); process.stderr.write("err")'],
      new AbortController().signal,
    )
    expect(result).toEqual({ stdout: 'out✓', stderr: 'err' })
  })

  it('rejects a non-zero exit with code, stdout, and stderr attached', async () => {
    const failure = await runNativeCommand(
      node,
      ['-e', 'process.stdout.write("partial"); process.stderr.write("boom"); process.exit(3)'],
      new AbortController().signal,
    ).then(() => { throw new Error('unexpected resolve') }, (error: unknown) => error)
    expect(failure).toMatchObject({ code: 3, stdout: 'partial', stderr: 'boom' })
    expect((failure as Error).cause).toBeInstanceOf(Error)
  })

  it('rejects a missing executable with the spawn ENOENT code', async () => {
    const failure = await runNativeCommand(
      'dsh-definitely-missing-command',
      [],
      new AbortController().signal,
    ).then(() => { throw new Error('unexpected resolve') }, (error: unknown) => error)
    expect(failure).toMatchObject({ code: 'ENOENT' })
  })

  it('terminates the child when the signal aborts', async () => {
    const abort = new AbortController()
    const pending = runNativeCommand(node, ['-e', 'setTimeout(() => {}, 60_000)'], abort.signal)
    abort.abort()
    const failure = await pending.then(() => { throw new Error('unexpected resolve') }, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as { code?: unknown }).code).toBe('ABORT_ERR')
  })
})

describe('hidesWindows', () => {
  // The file manager is the one command that must keep its window: a hidden
  // explorer.exe still exits with the code the caller reads as a delegated
  // handoff, so the reveal reports success while showing nothing.
  it.each([
    'explorer.exe',
    'EXPLORER.EXE',
    'Explorer.exe',
    'C:\\Windows\\explorer.exe',
    'C:/Windows/explorer.exe',
  ])('keeps the window for %s', (command) => {
    expect(hidesWindows(command)).toBe(false)
  })

  it.each([
    'powershell.exe',
    'wslpath',
    'xdg-open',
    'open',
    '/usr/bin/xdg-open',
  ])('hides the console for %s', (command) => {
    expect(hidesWindows(command)).toBe(true)
  })
})

describe('launchesDetached', () => {
  // execFile captures output through pipes, and a file-manager request started
  // with redirected stdio opens no folder: /select degrades to the default
  // location instead of the requested one.
  it.each([
    'explorer.exe',
    'EXPLORER.EXE',
    'C:\\Windows\\explorer.exe',
  ])('detaches the windowed shell for %s', (command) => {
    expect(launchesDetached(command)).toBe(true)
  })

  it.each([
    'powershell.exe',
    'xdg-open',
    'open',
    'node',
  ])('keeps attached stdio for %s', (command) => {
    expect(launchesDetached(command)).toBe(false)
  })
})
