---
name: task-id-bootstrap
description: Use when the user says `新开task-id=...`, `新开 task-id=...`, `继续，task-id=...`, `开 task-id=...`, `创建 task-id`, `初始化 task-id`, or otherwise expects repo-local task state to become active for the current dsh (DeepSeek Harness) session. Works on macOS, Linux, and Windows.
---

# Task ID Bootstrap

## Overview

Interpret `task-id` requests as filesystem and session state, not just
conversational scope. A task is open only when its state files exist and the
current session transcript is bound to it.

This is the dsh (DeepSeek Harness) edition of the shared handoff kit's
bootstrap. The state layout under `.agents/state/` is identical to the
Codex and Claude editions, so the same repository can be shared across all
three agents.

## Outcome Contract

Treat these as separate results:

| Result | Required proof |
|---|---|
| Task initialized | `.agents/state/tasks/<task-id>/process.md` and `process.recent.md` exist |
| Task activated | `.agents/state/current-task` contained `<task-id>` when bootstrap completed |
| Current session bound | `session-tasks.json` maps the exact current transcript to `<task-id>` |

**Do not say the current task was switched unless all three are verified.** A
created directory by itself is only an initialized task.

## Prerequisites

This skill's bootstrap script needs Python 3.9+. The `handoff` skill is pure
instructions and works without Python.

### Interpreter detection (platform-specific)

Verify the interpreter before the first bootstrap (cheap, no side effects):

- macOS / Linux: `python3 --version`
- Windows — **treat Windows 10 and Windows 11 differently**:

  | Check | Windows 10 | Windows 11 |
  |---|---|---|
  | First command to try | `py -3 --version` | `py -3 --version` |
  | `py` launcher present? | Only if the python.org installer was run, or the standalone py launcher was installed; it is not guaranteed on a clean system | Usually present once any python.org Python is installed; the new "Python install manager" (PyManager, Store) also registers a `python`/`py` surface but its behavior differs from the classic launcher |
  | Bare `python` means | App execution alias stub by default — typing it opens the Microsoft Store or prints "Python was not found"; a real python.exe from PATH can also lose priority to the stub | Same stub mechanism; on newer builds the alias may point at the Python install manager instead |
  | Fallback order | `py -3` → `python` → `python3` | `py -3` → `python` → `python3` |
  | Package installer | `winget` only on Win10 1809+ with App Installer, and it registers after first login; otherwise use choco/scoop or the python.org MSI | `winget` preinstalled; on home/pro systems behind policy, may still be absent — fall back to choco/scoop or the python.org installer |

  Never trust a bare `python` on Windows without checking what it resolves to:
  the Store alias stub exits nonzero and prints a "Python was not found" hint,
  and pymanager's alias prints its own banner. When `py -3 --version` prints a
  real `Python 3.9+` version line, use `py -3`. When in doubt, run
  `Get-Command python, python3, py -ErrorAction SilentlyContinue` and inspect
  the `Source` paths: a stub lives under
  `WindowsApps\python*.exe`, a real interpreter under
  `Python3x\python.exe`, `%LocalAppData%\Python`, or a package-manager shim.

### Installing Python with consent

If the interpreter is missing, do not silently install system packages:

1. Report the missing prerequisite plus the exact command for this platform,
   and ask the user for consent:
   - macOS: `xcode-select --install` (system python3) or `brew install python3`
   - Debian/Ubuntu: `sudo apt-get install -y python3`
   - Fedora: `sudo dnf install -y python3`
   - Arch: `sudo pacman -S --noconfirm python`
   - Windows 11: `winget install -e --id Python.Python.3.12`
     (alternatives: `choco install python3` or `scoop install python`)
   - Windows 10: try the same `winget` command only if `winget --version`
     works; otherwise recommend `choco install python3`, `scoop install python`,
     or the python.org installer (pick "Add python.exe to PATH" so the classic
     `py` launcher is registered)
2. Only after explicit user consent, run that command for the user, then
   re-verify the version before continuing.
3. If the user declines, stop and report that task-id bootstrap is
   unavailable while the `handoff` skill remains usable. Never rewrite the
   bundled scripts into another language on the fly to bypass a missing
   interpreter: the bundled lock module keeps `.agents/state/` safe when the
   Codex or Claude editions share the same repository, and its lock semantics
   must stay identical across all editions.
4. After any Windows install, if a real interpreter still loses to the Store
   alias stub, tell the user to open "Manage app execution aliases" from
   Start, switch the "App Installer" Python entries to "Off", then re-verify
   with `py -3 --version`. Do not attempt to edit alias settings yourself:
   they are user settings and the Settings app owns them.

## Workflow

1. Read repo instructions first.
   Check `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and existing `.agents/state/` files before acting.

2. Resolve the requested task id.
   Accept adjacent Chinese and punctuation forms such as
   `新开task-id=init-kmp`, `新开 task-id=init-kmp`, and `继续，task-id=init-kmp`. Reject values outside
   `[A-Za-z0-9][A-Za-z0-9._-]{0,79}`.

3. Run the bundled bootstrap script in strict mode.
   The script lives next to this SKILL.md at `scripts/bootstrap_task_id.py`.
   When this skill was loaded, the `skill` tool result reported a
   `resourceBase` — substitute it for `<resourceBase>` below. Always quote
   the whole path: on macOS the workspace path often contains spaces
   (e.g. `Library/Mobile Documents/...`).

   On macOS / Linux (bash or zsh), bind the current dsh session via the
   managed `DSH_SESSION_JSONL` variable:

   ```bash
   python3 "<resourceBase>/scripts/bootstrap_task_id.py" \
     --repo /absolute/path/to/repo \
     --task-id init-kmp \
     --transcript-path "$DSH_SESSION_JSONL"
   ```

   On Windows, dsh runs PowerShell: use the `py -3` launcher (fall back to
   `python` if `py` is unavailable) and the PowerShell environment syntax:

   ```powershell
   py -3 "<resourceBase>\scripts\bootstrap_task_id.py" `
     --repo C:\absolute\path\to\repo `
     --task-id init-kmp `
     --transcript-path "$env:DSH_SESSION_JSONL"
   ```

   The bundled state lock chooses `msvcrt` on Windows and `fcntl` on POSIX
   automatically; do not replace it with an unlocked write when adapting this
   script.

   If `DSH_SESSION_JSONL` is not set in the current shell (for example, a
   detached terminal outside dsh), pass `--allow-unbound` only for explicitly
   requested offline initialization. That mode initializes the files but does
   not bind the current session, and the result must be reported as partial.

4. Require successful binding output.
   A complete switch prints all of these and exits zero:

   ```text
   Task state: .../.agents/state/tasks/init-kmp
   Current task: init-kmp
   Session binding: /absolute/path/to/session.jsonl.zstd
   Effective task: init-kmp
   ```

   Exit code `2` with `Session binding: NOT BOUND` is a partial result. Report
   that the files and global pointer were initialized, but the current session
   was not bound. Never rewrite that result as success.

5. Initialize and maintain concise task state.
   Keep `process.md` and `process.recent.md` action-oriented. Include:
   - Current Task
   - Done
   - Key Files
   - Verification
   - Current Constraints
   - Next Step

6. Keep task state isolated.
   After a task id is active, read and update only
   `.agents/state/tasks/<task-id>/process.md` and its sibling fallback files.
   Every session is task-local; a session without an explicit, mapped, or
   current task uses `.agents/state/tasks/main/`. Root `process.md`, auto,
   recent, and guard files are legacy payloads and must never be read or written.

7. Confirm each result separately.
   Report the task path and bound transcript. Verify branch creation separately.
   `current-task` is a shared last-active pointer and another session may
   legitimately change it later; `session-tasks.json` is authoritative for
   restoring a particular session.

## State Template

Use this structure for both `process.md` and `process.recent.md` unless the repo already defines a stronger format:

```markdown
## Current Task
- <one-line task>

## Done
- <completed item>

## Key Files
- `<path>`

## Verification
- PASS: `<command or inspection>`
- NOT RUN: `<command>` -> <reason>

## Current Constraints
- <constraint>

## Next Step
- <smallest next action>
```

## Cross-platform notes

- **Python launcher**: `python3` on macOS/Linux; on Windows prefer `py -3`,
  falling back to `python`. The script requires Python 3.9+.
- **Path quoting**: always quote paths that may contain spaces. macOS
  workspaces under `iCloud Drive` or `Mobile Documents` almost always do.
- **Path separators**: the script accepts either `/` or `\` on Windows; in
  PowerShell examples use `\`, in bash use `/`.
- **Session variable**: `DSH_SESSION_JSONL` is exported by dsh into the
  managed bash and PowerShell environments. Reference it as
  `"$DSH_SESSION_JSONL"` in bash and `"$env:DSH_SESSION_JSONL"` in PowerShell.
- **Shared state**: Codex binds its rollouts and Claude its transcripts with
  the same `session-tasks.json` map. dsh binding the same repo does not
  disturb entries written by the other agents.

## Common Mistakes

| Mistake | Fix |
|---|---|
| Creating only a git branch | Treat branch creation and task-id creation as separate responsibilities. |
| Updating root `.agents/state/process.md` | Always use `.agents/state/tasks/<task-id>/`; use `main` when no task is selected. |
| Synchronizing task progress into root `process.md` | Root payload files are retired and must remain ignored. |
| Reporting success after only creating the folder | Require `Session binding` and matching `Effective task` output. |
| Treating `current-task` as a permanent session binding | Use the exact transcript entry in `session-tasks.json` for per-session recovery. |
| Guessing the repo root from memory | Use the current workspace root or a user-provided repo path. |
| Dropping quotes around `<resourceBase>` on macOS | Spaces in the path split the command; keep the double quotes. |

## Example

User request:

```text
新开task-id=init-kmp，然后开个 init-kmp 分支
```

Expected outcome:
- Create `.agents/state/tasks/init-kmp/`
- Initialize `process.md` and `process.recent.md`
- Write `init-kmp` to `.agents/state/current-task`
- Bind the exact current transcript entry in `session-tasks.json` to `init-kmp`
- Create or switch to branch `init-kmp`
- Report state creation, session binding, and branch switching separately
