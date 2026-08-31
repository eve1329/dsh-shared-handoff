# shared-handoff-dsh

[English](README.md) | [中文](README.zh.md)

A DeepSeek Harness (`dsh`) skill plugin that ports the shared-handoff-kit's
handoff workflow: it packages the `handoff` and `task-id-bootstrap` skills
with zero dependencies and no build step, adapted for macOS, Linux, and
Windows (including Windows 10 vs Windows 11 Python environment differences).

## Skills

| Skill | What it does | Requires |
|---|---|---|
| `handoff` | Evidence-driven session handoff: export/resume, interoperable across Codex, Claude, and dsh | Nothing (pure instructions) |
| `task-id-bootstrap` | Repo-local task state under `.agents/state/tasks/<task-id>/`, binding the current dsh session (`DSH_SESSION_JSONL`) to the task | Python 3.9+ |

## Install

```sh
dsh plugin --profile web add shared-handoff-dsh
```

After restarting `dsh web`, both skills join the skill catalog and the model
loads them through the `skill` tool.

## Usage

Once installed there is **no command to remember** — the skills are
triggered conversationally and the model loads the right SKILL.md itself.

### task-id-bootstrap: open a task

Just say in a dsh chat (adjacent Chinese/English punctuation both work):

```text
新开task-id=init-kmp，然后开个 init-kmp 分支
```

The model runs the bundled bootstrap script; success is proven by three
lines:

```text
Task state: .../.agents/state/tasks/init-kmp
Current task: init-kmp
Session binding: /Users/you/.dsh/sessions/.../session.jsonl.zstd
```

Progress then lives in `.agents/state/tasks/init-kmp/process.md`; say
`继续，task-id=init-kmp` later to resume. **A directory without a session
binding is only a partial result** — the model must report it as such.

If Python (3.9+) is missing on first use, the model reports the gap and
shows the install command for your platform, installing **only after your
explicit consent** — never silently.

### handoff: export / resume a session

When a thread gets long and you want a fresh one, say:

```text
帮我做个 handoff
```

You get a **paste-ready next-thread prompt** (workspace / branch / done /
verification status / next step). In the fresh session, open with:

```text
继续上次 handoff
```

The model rebuilds context from state files instead of chat history.
Phrases like `交接`, `新开线程继续`, `继续上次`, and `resume` trigger it too.

### The two skills cooperate

When a `task-id` is active in the same repo, `handoff` treats
`.agents/state/tasks/<task-id>/process.md` as the canonical state instead
of inventing a parallel one.

### Cross-agent handoff

The state layout is identical to the Codex and Claude editions: a handoff
exported from dsh can be resumed in Codex or Claude and vice versa (all
three share the same `session-tasks.json`).

## Automation (hook equivalents)

The three behaviors the original kit implemented through Codex/Claude hooks
run automatically on the dsh host side via the harness event system —
**installed, they just work**:

| Original hook | dsh equivalent | Behavior |
|---|---|---|
| `SessionStart` | first `agent/pre-step` (step 1) | The active task's `process.md` / `process.auto.md` is injected as a baseline user message — say "继续" in a fresh session and the state is already there; the baseline ends with a reminder to run the `handoff` skill after completing a milestone, keeping the semantic state fresh |
| `UserPromptSubmit` (task routing) | `agent/pre-step` message scan | A `task=<id>` marker in the incoming user message re-binds the session and switches `current-task` (creating the task dir), then injects a switch notice for the new task |
| Continuation | `agent/pre-step` message scan | A short continuation prompt (继续 / 接着 / resume / 交接 …) re-injects the persisted state mid-session, labeled as a re-injection |
| `Stop` | `session/event` `turn/end` | `process.auto.md` is refreshed after every turn (capturing the turn's last model output) and mirrored into an existing `process.recent.md`; the same turn also appends one summary line to the `## Auto Log` section of `process.md` (newest last, capped at `maxLogEntries`, hand-written sections untouched) |
| `PreCompact` / `PostCompact` | `compaction/start` / `compaction/summary` | Snapshots are written before and after compaction plus a `context_guard.json` marker; completed compactions increment `auto_compact_count`, and at `compactThreshold` (default 3) `clear_required` flips on and the next injected baseline carries a controlled-clear notice (hand off, start a fresh session) |

Task resolution matches the original: the session's transcript binding in
`session-tasks.json` first (dsh sessions align by their transcript path
under `$DSH_HOME/sessions`), then the `current-task` pointer. Every write
lands in the same `.agents/state/` the Codex/Claude editions use.

**Interop with the Codex and pi editions**: `context_guard.json` is written
read–merge–write with the Codex field contract (`auto_compact_count`,
`clear_required`, `threshold`, `last_*`), and keys owned by other runtimes
(`pi_compact_count`, `last_pi_session_id`, …) pass through untouched. The
clear threshold check sums the pi and dsh counters together, so one repo
alternated between runtimes still guards correctly.

To disable a piece, override the row in your profile patch:

```yaml
- id: shared-handoff
  name: 'shared-handoff-dsh'
  config:
    injectBaseline: false   # no session-start injection
    autoSnapshot: false     # no per-turn snapshots
    autoLog: false          # no per-turn Auto Log lines in process.md
    compactionGuard: false  # no compaction guard
    handoffReminder: false  # no proactive-handoff reminder in the baseline
    maxLogChars: 300        # per-entry truncation for Auto Log lines
    maxLogEntries: 100      # Auto Log section length cap
    compactThreshold: 3     # compactions before a controlled clear is advised
```

`process.auto.md` and `context_guard.json` are host-owned metadata — the
SKILL.md tells the model never to hand-write them; `process.md` stays
model-maintained except for the host-appended `## Auto Log` section at its
end.

## Design notes

- **archify-dsh pattern**: `cordis.patch.yml` mounts an isolated
  `@deepseek-ai/dsh-skill-filesystem` instance (`includeDefaultRoots: false`
  + a unique `providerName` + `bundledSkillDir` pointing at the packaged
  `skills/`), leaving the stock `filesystem` provider untouched.
- **Host half (hook equivalents)**: zero external dependencies (Node
  builtins only) — listens to `agent/pre-step` and `session/event` for
  injection/snapshots/guard, see Automation above; listeners swallow their
  own errors, so a snapshot failure can never break the agent loop.
- **Session binding**: dsh injects `DSH_SESSION_JSONL` (the current session
  transcript path) into the managed bash/PowerShell environment; the
  bootstrap script binds it via `--transcript-path` with zero script changes,
  writing into the same `session-tasks.json` the Codex/Claude editions use.
- **Cross-platform**: the SKILL.md ships both bash and PowerShell command
  forms plus a Windows 10/11 Python detection matrix (py launcher, Store
  alias stub, winget availability); the lock module uses `fcntl` on POSIX
  and `msvcrt` on Windows, identical to the original.
- **Missing Python**: never installed silently — report the gap, show the
  platform-specific command, install only after explicit consent; the
  `handoff` skill and the host-half automation work regardless (they need
  no Python).

## Known limitations

- Only the two platform-neutral skills were ported; `claude-handoff`
  (Claude Code specific) and the Codex/Claude hook runtimes stay with the
  original kit.
- The auto snapshot records the turn's last model output verbatim (facts,
  not summaries) — semantic progress still lives in the model-maintained
  `process.md`; the `## Auto Log` section gives it a per-turn, timestamped
  trail without replacing that curation.
- Local path installs (`dsh plugin add <path>`) resolve as a link;
  publishing to npm is the sturdier sharing route.

## License

MIT (inherited from shared-handoff-kit).
