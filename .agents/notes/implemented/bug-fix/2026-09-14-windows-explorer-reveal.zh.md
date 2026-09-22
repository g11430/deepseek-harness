# Agent Note: Windows file-manager reveal shows and focuses the folder window

Status: implemented

[English](2026-09-14-windows-explorer-reveal.md) | 中文

## Problem

在 Windows 文件管理器中揭示交付文件时，操作报告成功，却没有任何用户能看到的结果。`revealNativePath` 通过共享 runner 启动 `explorer.exe /select,<路径>`，并把它的非零退出码当作委托交接，于是 Host 返回 `204`、Client 渲染成功文案。窗口要么根本没有出现，要么出现在刚刚接受点击的那个应用后面；文件管理器有时还会停在默认位置而不是请求的文件夹。

三个互不相同的缺陷产生了同一个表象，而且每一个都掩盖着下一个：被隐藏的窗口无法获得焦点，而一个从未执行的聚焦请求也无法被观察到它没有命中目标。

## Decision

`runNativeCommand` 为控制台命令保留其捕获 UTF-8 输出的路径，并为那些目的就是显示窗口的命令新增一条分离启动的路径。

- `hidesWindows(command)` 对 `explorer.exe` 保持 `windowsHide: false`。窗口隐藏此前被施加于所有命令，因而丢弃了文件管理器存在的意义所要显示的那个窗口。
- `launchesDetached(command)` 以 `detached: true` 与 `stdio: 'ignore'` 启动 `explorer.exe`。`execFile` 通过管道捕获输出，而 Windows shell 会拒绝一个以重定向 stdio 启动的文件管理器请求，于是 `/select` 退化为默认位置。分离启动没有观察者去看退出状态，而这正是委托交接本就假定的情形。
- `revealNativePath` 向 `/select` 传递文件系统路径，而不再是 `file://` URI。percent 编码的 URI 在此并不等价：Explorer 会回退到默认位置，这是同一个可见故障的另一个成因。
- `activateFileManagerWindow(path)` 在选择成功之后运行一个分离的 PowerShell 助手。选择会打开或复用该文件夹的窗口，但不会激活它，所以窗口留在调用者后面。Windows 拒绝来自不拥有前台资格的进程的前台请求，`AppActivate` 同样受此约束；而还原一个本进程刚刚最小化的窗口是官方记载的例外，因此助手对它找到的窗口执行最小化再还原。它优先选择当前选中项已包含被揭示文件的窗口，否则接受该文件夹窗口。策略以 `-EncodedCommand` 文本传行，从而对任意路径或文件名都免于 argv 引号转义；`PathOpenerInternals.activate` 让测试可以替换它。

## Alternatives considered

**依赖 `Start-Process` 式的 shell 调用。** 经 shell 启动会继承同样的重定向 stdio 与同样的缺陷，并且会在 Host 与可执行文件之间引入本包刻意回避的 shell。

**在揭示路径上改用 `openNativePath` 的 `powershell.exe Invoke-Item`。** `Invoke-Item` 是用关联应用打开文件，而不是在其文件夹中选中它，因此它回答的是另一个请求。

**改由 Electron 的 `shell.showItemInFolder` 接管窗口。** Electron 外壳已经信任 `dsh-app://` 渲染器，但揭示动作发起于随包发布的 dsh Host —— 一个独立的 Node 进程，不持有任何 Electron API。把该手势改道经过渲染器或新增一次 IPC 跳转，会拓宽那层让渲染器免于文件系统与 shell 访问的桌面信任边界，代价远大于该缺陷本身。

**按窗口标题而非文件夹 URL 激活。** 标题会被本地化、可能重复，并随视图变化；URL 加上当前选中项才能标识该请求实际产生的窗口。

**保留 URI 并在调用前 percent 解码。** 解码后的结果正是文件系统路径本身，因此 URI 往返只增加了一个可能与 shell 自身解析结果不一致的步骤。

## Consequences

文件管理器现在成为该包捕获输出契约之外唯一的命令：`runNativeCommand` 对它以空输出 resolve，因为分离的窗口化 shell 没有流可报告。它的退出码从来就没有意义 —— Explorer 在把请求交给运行中的桌面进程后返回 1 —— 而 `revealNativePath` 对确实会报告退出码的路径仍然接受该码。

前台交接是尽力而为。助手在约十二秒后放弃，而那时揭示本身已经成功，因此一个留在调用者后面的窗口不会被报告为失败。这是本改动中唯一无法在单元测试中断言的部分：它取决于桌面真实的窗口状态，包内测试通过 `PathOpenerInternals.activate` 替换它。该行为已在 Windows 10 build 19045 上通过驱动真实 Explorer 窗口验证：观察 `CabinetWClass` 的创建以及调用前后的前台窗口，ASCII 与非 ASCII 文件名均已覆盖。

## Testing

`packages/util/native-command/tests/native-command.spec.ts` 为文件管理器与控制台命令分别固定 `hidesWindows` 与 `launchesDetached`，含绝对路径与大小写。`packages/util/native-command/tests/path-opener.spec.ts` 固定 `/select` 原样收到文件系统路径（名字含空格、逗号、百分号与非 ASCII 字符），固定 WSL 转换结果以转换后的路径抵达 Explorer，并固定只有 Explorer 分支执行前台交接。

spec 对 `node:child_process` 的模块 mock 同时提供 `spawn`：Explorer 分支现在会启动前台助手，而只导出 `execFile` 的 mock 会让缺失导出在揭示过程中抛错，从而顶替掉断言真正要考察的失败。另有若干用例改为注入 `run` 而非依赖该 mock，理由是确定性：这样断言就不再取决于运行测试的机器上真实 `explorer.exe` 的行为。
