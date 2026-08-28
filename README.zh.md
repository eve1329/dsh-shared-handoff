# shared-handoff-dsh

[English](README.md) | 中文

把 [shared-handoff-kit](https://github.com/) 的 handoff 工作流带入 DeepSeek
Harness（`dsh`）的技能插件：打包 `handoff` 与 `task-id-bootstrap` 两个技能，
零依赖、零构建，适配 macOS、Linux 与 Windows（区分 Win10 / Win11 的 Python
环境差异）。

## 技能

| 技能 | 说明 | 需要什么 |
|---|---|---|
| `handoff` | 证据驱动的会话交接：导出/恢复，跨 Codex、Claude、dsh 通用 | 无（纯指令） |
| `task-id-bootstrap` | 仓库本地任务状态 `.agents/state/tasks/<task-id>/`，并把当前 dsh 会话（`DSH_SESSION_JSONL`）绑定到任务 | Python 3.9+ |

## 安装

```sh
dsh plugin --profile web add shared-handoff-dsh
```

重启 `dsh web` 后，两个技能进入技能目录，模型经 `skill` 工具加载。

## 使用

装好后**不需要任何命令**——技能由对话触发，模型自动加载对应 SKILL.md。

### task-id-bootstrap：开一个任务

在 dsh 对话里直接说（中英文标点都行）：

```text
新开task-id=init-kmp，然后开个 init-kmp 分支
```

模型会运行打包的 bootstrap 脚本，你要的产出是三行证明：

```text
Task state: .../.agents/state/tasks/init-kmp
Current task: init-kmp
Session binding: /Users/you/.dsh/sessions/.../session.jsonl.zstd
```

之后这个任务的进展记录在 `.agents/state/tasks/init-kmp/process.md`，下次说
`继续，task-id=init-kmp` 即可恢复。**注意：只有目录没有绑定 = 部分成功**，
模型应如实报告。

首次使用时若机器缺 Python（3.9+），模型会先报告缺失并给出你平台对应的
安装命令，**征得你同意后才会代装**，不会静默安装。

### handoff：交接 / 续接会话

对话变长、想换新会话继续时，说：

```text
帮我做个 handoff
```

得到一份**可直接粘贴进新会话**的交接提示词（工作区/分支/已完成/验证状态/
下一步）。反过来，新会话开头说：

```text
继续上次 handoff
```

模型会从状态文件（而非聊天记录）重建上下文。`交接`、`新开线程继续`、
`继续上次`、`resume` 等说法同样触发。

### 两个技能配合

同一仓库里 `task-id` 激活后，`handoff` 导出/恢复会自动认
`.agents/state/tasks/<task-id>/process.md` 为准，不会另起一套状态。

### 跨 agent 交接

状态布局与 Codex / Claude 版完全一致：在 dsh 里导出的交接，可以贴到
Codex 或 Claude 里恢复，反之亦然（`session-tasks.json` 三方共用）。

## 设计要点

- **archify-dsh 模式**：`cordis.patch.yml` 挂载一个隔离的
  `@deepseek-ai/dsh-skill-filesystem` 实例（`includeDefaultRoots: false` +
  唯一 `providerName` + `bundledSkillDir` 指向包内 `skills/`），不影响
  原生 `filesystem` 提供方。
- **会话绑定**：dsh 在受管 bash/PowerShell 环境注入 `DSH_SESSION_JSONL`
  （当前会话 transcript 路径），bootstrap 脚本以 `--transcript-path` 绑定，
  脚本本体零改动，与 Codex/Claude 版写入同一份 `session-tasks.json`。
- **跨平台**：SKILL.md 内置 bash 与 PowerShell 双命令、Win10/Win11 Python
  检测差异表（py 启动器、Store 别名 stub、winget 可用性）；锁模块在
  POSIX 用 `fcntl`、Windows 用 `msvcrt`，与原版语义一致。
- **缺 Python 时**：不静默安装——报告缺失、给出平台对应命令、征得同意后
  才代装；`handoff` 技能不受影响。

## 已知限制

- 只迁移了两个平台无关技能；`claude-handoff`（Claude Code 专属）与
  Codex/Claude 的 hook 运行时不属于本插件，仍由原 kit 安装。
- 本地路径安装（`dsh plugin add <路径>`）为 link/拷贝形态，发 npm 后与他
  人共享更稳妥。

## License

MIT（沿用 shared-handoff-kit）。
