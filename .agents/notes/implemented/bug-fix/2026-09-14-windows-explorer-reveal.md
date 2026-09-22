# Agent Note: Windows file-manager reveal shows and focuses the folder window

Status: implemented

English | [中文](2026-09-14-windows-explorer-reveal.zh.md)

## Problem

Revealing a delivered file in the Windows file manager reported success while showing nothing the user could see. `revealNativePath` spawned `explorer.exe /select,<path>` through the shared runner and treated its non-zero exit as a delegated handoff, so the Host answered `204` and the Client rendered its success copy. The window either never appeared or appeared behind the application that had just received the click, and the file manager sometimes landed on its default location instead of the requested folder.

Three independent defects produced that single symptom, and each one hides the next: a hidden window cannot be focused, and a focus request that never runs cannot be observed to miss its target.

## Decision

`runNativeCommand` keeps its captured-UTF-8 path for console commands and gains a detached path for commands whose purpose is to put a window on screen.

- `hidesWindows(command)` keeps `windowsHide: false` for `explorer.exe`. Windows hide was applied to every command, which discarded the window the file manager exists to show.
- `launchesDetached(command)` starts `explorer.exe` with `detached: true` and `stdio: 'ignore'`. `execFile` captures output through pipes, and the Windows shell refuses a file-manager request whose process was started with redirected stdio, so `/select` degraded to the default location. A detached launch has nobody to observe the exit status, which is what the delegated handoff already assumed.
- `revealNativePath` passes the file-system path to `/select` instead of a `file://` URI. A percent-encoded URI is not equivalent here: Explorer falls back to its default location, which is the same visible failure with a different cause.
- `activateFileManagerWindow(path)` runs a detached PowerShell helper after a successful select. Selecting opens or reuses the folder's window without activating it, so the window stays behind the caller. Windows refuses a foreground request from a process that does not own the foreground and `AppActivate` is subject to that rule; restoring a window this process just minimized is the documented exception, so the helper minimizes and restores the window it found. It prefers the window whose selection already contains the revealed file and settles for the folder window otherwise. The policy travels as `-EncodedCommand` text, which keeps it out of argv quoting for any path or file name, and `PathOpenerInternals.activate` lets tests replace it.

## Alternatives considered

**Rely on `Start-Process`-style shell invocation.** Launching through a shell would inherit the same redirected stdio and the same defect, and it would put a shell between the Host and the executable that the package deliberately avoids.

**Use `openNativePath`'s `powershell.exe Invoke-Item` path for reveal.** `Invoke-Item` opens the file with its associated application rather than selecting it in its folder, so it answers a different request.

**Take the window through Electron's `shell.showItemInFolder`.** The Electron shell already trusts the `dsh-app://` renderer, but the reveal originates in the bundled dsh Host, a separate Node process that holds no Electron API. Routing the gesture through the renderer or a new IPC hop would widen the desktop trust boundary that keeps renderers free of filesystem and shell access, which is a larger change than the defect justifies.

**Activate by window title instead of by folder URL.** Titles are localized, can repeat, and change with the view; the URL plus the current selection identifies the window the request actually produced.

**Keep the URI and percent-decode before the call.** Decoding is what the file-system path already is, so the URI round trip only adds a step that can disagree with the shell's own parsing.

## Consequences

The file manager is now the one command outside the package's captured-output contract: `runNativeCommand` resolves with empty output for it, because a detached windowed shell has no streams to report. Its exit code was never meaningful — Explorer returns 1 after handing the request to a running desktop process — and `revealNativePath` still accepts that code for the paths that do report it.

The foreground handoff is best-effort. The helper gives up after roughly twelve seconds and the reveal itself has already succeeded by then, so a window that stays behind the caller is not reported as a failure. This is the one part of the change that cannot be asserted in a unit test: it depends on the desktop's real window state, and the package tests replace it through `PathOpenerInternals.activate`. The behavior was verified on Windows 10 build 19045 by driving a real Explorer window: observing `CabinetWClass` creation and the foreground window before and after the call, with both the ASCII and non-ASCII file names.

## Testing

`packages/util/native-command/tests/native-command.spec.ts` pins `hidesWindows` and `launchesDetached` for both the file manager and the console commands, including absolute paths and casing. `packages/util/native-command/tests/path-opener.spec.ts` pins that `/select` receives the file-system path unchanged for names carrying spaces, commas, percent signs, and non-ASCII characters, that the WSL translation reaches Explorer as the translated path, and that exactly the Explorer branch performs the foreground handoff.

The spec's module mock for `node:child_process` also supplies `spawn`, because the Explorer branch now starts the foreground helper and a mock exporting only `execFile` makes the missing export throw inside the reveal, which replaces the failure the assertions are about. Several cases inject `run` instead of relying on that mock, for determinism: their assertions then do not depend on what a real `explorer.exe` does on the machine running the suite.
