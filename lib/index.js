import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

export const name = 'shared-handoff-dsh';
export const PACKAGE_NAME = 'shared-handoff-dsh';

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/**
 * Resolve this package's bundled skills root relative to the DSH profile.
 * Mirrors the resolution used in cordis.patch.yml so tests and diagnostics
 * can verify both agree. Works identically on macOS, Linux, and Windows.
 *
 * @param {string | URL} profileBaseUrl - the DSH profile Loader baseUrl.
 * @returns {string} absolute path of the packaged skills directory.
 */
export function resolveSkillRoot(profileBaseUrl) {
	if (!profileBaseUrl) {
		throw new Error('shared-handoff-dsh: missing DSH profile baseUrl for package resolution');
	}
	let manifestPath;
	try {
		manifestPath = createRequire(profileBaseUrl).resolve(`${PACKAGE_NAME}/package.json`);
	} catch (error) {
		throw new Error(
			`shared-handoff-dsh: cannot resolve ${PACKAGE_NAME}/package.json from the DSH profile`,
			{ cause: error },
		);
	}
	return join(dirname(manifestPath), 'skills');
}

//#region host half — hook equivalents for the shared handoff kit

/**
 * Host-side Cordis plugin: restores the automatic behaviors the original kit
 * implemented through Codex/Claude hooks, using the harness event system.
 *
 * - `agent/pre-step` (step 1) injects the active task's state as a baseline
 *   user message — the SessionStart hook equivalent.
 * - `session/event` `turn/end` refreshes `process.auto.md` (and mirrors into
 *   `process.recent.md` when it exists) and appends one summary line to the
 *   `## Auto Log` section of `process.md` — the Stop hook equivalent.
 * - `session/event` `compaction/start` / `compaction/summary` write a
 *   snapshot plus the `context_guard.json` marker — the PreCompact /
 *   PostCompact hook equivalents.
 *
 * All writes target the same `.agents/state/` layout the Codex and Claude
 * editions use, under the session's own working directory. Every listener
 * swallows its own errors: snapshotting must never break the agent loop.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {Record<string, unknown>} [rawConfig] - plugin row config.
 * @returns {void}
 */
export function apply(ctx, rawConfig = {}) {
	const cfg = resolveConfig(rawConfig);
	if (!cfg.enabled) return;

	/** Sessions whose baseline was already injected (first pre-step only). */
	const injected = new WeakSet();
	/** sessionId → transcript path cache (session dirs never move). */
	const transcriptCache = new Map();

	ctx.on('agent/pre-step', async (payload, next) => {
		const { agent, step } = payload ?? {};
		const decision = await next();
		try {
			if (!cfg.injectBaseline || decision?.kind !== 'enter' || step !== 1) return decision;
			const session = agent?.session;
			if (session === undefined || injected.has(session)) return decision;
			const tc = resolveTaskContext(session, cfg, transcriptCache);
			if (tc === undefined) return decision;
			const text = composeBaseline(tc, cfg);
			if (text === undefined) return decision;
			injected.add(session);
			return { kind: 'enter', messages: [...decision.messages, baselineMessage(text)] };
		} catch (error) {
			warn(ctx, `baseline injection skipped: ${describe(error)}`);
			return decision;
		}
	});

	ctx.on('session/event', (session, event) => {
		try {
			const type = event?.type;
			if (type !== 'turn/end' && type !== 'compaction/start' && type !== 'compaction/summary') return;
			const tc = resolveTaskContext(session, cfg, transcriptCache);
			if (tc === undefined) return;
			const data = eventData(event);
			if (type === 'turn/end') {
				const turn = eventTurn(data);
				const reply = lastAssistantText(session, turn);
				if (cfg.autoSnapshot) writeSnapshot(tc, cfg, { phase: 'turn-end', turn, body: reply });
				if (cfg.autoLog) appendProcessLog(tc, cfg, { phase: 'turn-end', turn, body: reply });
				return;
			}
			if (type === 'compaction/start') {
				if (cfg.compactionGuard) {
					writeGuard(tc, cfg, 'start', {
						turn: typeof data.turn === 'number' ? data.turn : null,
						compactionId: stringOrEmpty(data.compactionId),
						last_event: 'PreCompact',
					});
				}
				if (cfg.autoSnapshot) {
					const turn = eventTurn(data);
					writeSnapshot(tc, cfg, {
						phase: 'pre-compaction',
						turn,
						body: lastAssistantText(session, turn),
					});
				}
				return;
			}
			if (type === 'compaction/summary') {
				if (cfg.compactionGuard) {
					// PostCompact equivalent: count completed compactions; at
					// the threshold demand a controlled clear (hand off, then
					// a fresh session). Merge-write keeps pi/codex counters.
					const guard = readGuard(tc);
					guard.auto_compact_count = (guard.auto_compact_count ?? 0) + 1;
					if (guard.auto_compact_count >= cfg.compactThreshold) guard.clear_required = true;
					writeGuard(tc, cfg, 'summary', {
						compactionId: stringOrEmpty(data.compactionId),
						last_event: 'PostCompact',
						last_trigger: 'auto',
					}, {
						auto_compact_count: guard.auto_compact_count,
						clear_required: guard.clear_required,
					});
				}
				if (cfg.autoSnapshot) {
					writeSnapshot(tc, cfg, { phase: 'post-compaction', body: extractText(data.summary) });
				}
			}
		} catch (error) {
			warn(ctx, `event snapshot skipped: ${describe(error)}`);
		}
	});
}

function resolveConfig(raw) {
	const source = raw ?? {};
	return {
		enabled: source.enabled !== false,
		injectBaseline: source.injectBaseline !== false,
		autoSnapshot: source.autoSnapshot !== false,
		autoLog: source.autoLog !== false,
		compactionGuard: source.compactionGuard !== false,
		handoffReminder: source.handoffReminder !== false,
		maxBaselineBytes: positiveInt(source.maxBaselineBytes, 16384),
		maxReplyChars: positiveInt(source.maxReplyChars, 4000),
		maxLogChars: positiveInt(source.maxLogChars, 300),
		maxLogEntries: positiveInt(source.maxLogEntries, 100),
		compactThreshold: positiveInt(source.compactThreshold, 3),
		dshHome: typeof source.dshHome === 'string' && source.dshHome !== ''
			? source.dshHome
			: (process.env.DSH_HOME || join(homedir(), '.dsh')),
	};
}

function positiveInt(value, fallback) {
	return Number.isInteger(value) && value > 0 ? value : fallback;
}

function describe(error) {
	return error instanceof Error ? `${error.message}` : String(error);
}

function warn(ctx, message) {
	try {
		ctx.logger?.warn?.(`shared-handoff-dsh: ${message}`);
	} catch {
		/* logging must never throw */
	}
}

function stringOrEmpty(value) {
	return typeof value === 'string' ? value : '';
}

function truncate(text, limit) {
	return text.length > limit ? `${text.slice(0, limit)}\n…(truncated)` : text;
}

/** Locate the session transcript file by scanning $DSH_HOME/sessions/<workspace>/<sessionId>/. */
function findTranscriptPath(sessionId, cfg, cache) {
	if (cache.has(sessionId)) return cache.get(sessionId);
	let found;
	try {
		const sessionsRoot = join(cfg.dshHome, 'sessions');
		for (const entry of readdirSafe(sessionsRoot)) {
			const candidate = join(sessionsRoot, entry, sessionId, 'session.jsonl.zstd');
			if (existsSync(candidate)) {
				found = candidate;
				break;
			}
		}
	} catch {
		found = undefined;
	}
	cache.set(sessionId, found);
	return found;
}

function readdirSafe(dir) {
	try {
		return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	} catch {
		return [];
	}
}

/**
 * Resolve the active task context for a session: its cwd must carry the kit's
 * `.agents/state/`, and the task comes from this session's transcript binding
 * in `session-tasks.json`, falling back to the `current-task` pointer.
 */
function resolveTaskContext(session, cfg, cache) {
	const cwd = session?.header?.cwd;
	if (typeof cwd !== 'string' || cwd === '') return undefined;
	const stateDir = join(cwd, '.agents', 'state');
	try {
		if (!existsSync(stateDir)) return undefined;
	} catch {
		return undefined;
	}
	const sessionId = String(session?.header?.id ?? session?.id ?? '');
	const transcriptPath = sessionId !== '' ? findTranscriptPath(sessionId, cfg, cache) : undefined;
	let taskId = '';
	if (transcriptPath !== undefined) {
		try {
			const mapping = JSON.parse(readFileSync(join(stateDir, 'session-tasks.json'), 'utf8'));
			const bound = mapping?.sessions?.[transcriptPath]?.task_id;
			if (typeof bound === 'string' && TASK_ID_RE.test(bound)) taskId = bound;
		} catch {
			/* unbound or unreadable mapping — fall through */
		}
	}
	if (taskId === '') {
		try {
			const pointer = readFileSync(join(stateDir, 'current-task'), 'utf8').trim();
			if (TASK_ID_RE.test(pointer)) taskId = pointer;
		} catch {
			/* no pointer */
		}
	}
	if (taskId === '') return undefined;
	const taskDir = join(stateDir, 'tasks', taskId);
	try {
		if (!existsSync(taskDir)) return undefined;
	} catch {
		return undefined;
	}
	return { cwd, stateDir, taskId, taskDir, transcriptPath };
}

/**
 * Text of the last text-bearing assistant message in `turn` (any turn when
 * null/undefined). Tool-call-only messages are skipped, so a turn whose final
 * step called tools still captures the text from its earlier steps, and the
 * scan never reaches back into earlier turns.
 */
function lastAssistantText(session, turn) {
	const events = Array.isArray(session?.events) ? session.events : [];
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (event?.type !== 'assistant/message') continue;
		const data = eventData(event);
		if (turn !== null && turn !== undefined) {
			if (typeof data.turn === 'number' && data.turn < turn) break;
			if (data.turn !== turn) continue;
		}
		const text = extractText(data.message?.content);
		if (text.trim() !== '') return text;
	}
	return '';
}

/**
 * DSH session events carry their payload under `data` (`{ type, seq, time,
 * data }`); the assistant messages in `session.events` use the same shape.
 * Returns `{}` for anything else so a shape drift degrades to empty fields
 * instead of throwing.
 */
function eventData(event) {
	const data = event?.data;
	return data !== null && typeof data === 'object' ? data : {};
}

/** The numeric turn an event belongs to, or undefined (absent / null). */
function eventTurn(data) {
	return typeof data?.turn === 'number' && Number.isFinite(data.turn) ? data.turn : undefined;
}

function extractText(content) {
	if (!Array.isArray(content)) return '';
	return content
		.filter((part) => part?.type === 'text' && typeof part.text === 'string')
		.map((part) => part.text)
		.join('\n\n');
}

/** Compose the baseline injection text from the task's state files. */
function composeBaseline(tc, cfg) {
	const parts = [];
	for (const file of ['process.md', 'process.auto.md']) {
		let text = '';
		try {
			text = readFileSync(join(tc.taskDir, file), 'utf8');
		} catch {
			continue;
		}
		if (!text.trim()) continue;
		parts.push(`### ${file}\n\n${truncate(text.trim(), cfg.maxBaselineBytes)}`);
	}
	if (parts.length === 0) return undefined;
	let guardNote = '';
	try {
		const guard = readGuard(tc);
		if (typeof guard?.phase === 'string' && guard.phase !== '') {
			guardNote = `\nCompaction guard: ${guard.phase} at ${guard.at ?? 'unknown time'}.`;
		}
		if (cfg.compactionGuard && guardNeedsClear(guard, cfg)) {
			const count = (guard.pi_compact_count ?? 0) + (guard.auto_compact_count ?? 0);
			guardNote += `\n⚠️ Compaction guard ALERT: this task has been auto-compacted ${count} times ` +
				`(threshold ${cfg.compactThreshold}); context quality has likely degraded. ` +
				`Recommend a controlled clear: run the \`handoff\` skill to persist progress, then start a fresh session — ` +
				`the new session's baseline injection restores this task's state automatically. ` +
				`If you choose to continue in this session anyway, ignore this notice.`;
		}
	} catch {
		/* no guard */
	}
	const reminder = cfg.handoffReminder
		? `\n\n以上是持久化的任务状态。请基于它继续工作,不要重复已完成的事项;完成阶段性工作后,主动运行 \`handoff\` 技能把进度(Done/Verification/Next Step 等)更新回 process.md,保持语义状态不过期。`
		: '';
	return `<shared-handoff>\nActive task: ${tc.taskId}\nRepo: ${tc.cwd}${guardNote}\n\n${parts.join('\n\n')}${reminder}\n</shared-handoff>`;
}

/** A user message in the harness shape — identical fields to createUserMessage output. */
function baselineMessage(text) {
	return Object.freeze({
		id: crypto.randomUUID(),
		role: 'user',
		content: Object.freeze([{ type: 'text', text }]),
		source: Object.freeze({ kind: 'plugin', plugin: name }),
	});
}

function atomicWriteText(path, content) {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	try {
		writeFileSync(temporary, content, 'utf8');
		renameSync(temporary, path);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {
			/* nothing to clean up */
		}
		throw error;
	}
}

/** Write `process.auto.md` (hook metadata) and mirror into an existing `process.recent.md`. */
function writeSnapshot(tc, cfg, { phase, turn, body }) {
	const rows = [
		'<!-- shared-handoff-dsh auto snapshot -->',
		'',
		`- Task: ${tc.taskId}`,
		`- Phase: ${phase}`,
	];
	if (Number.isFinite(turn)) rows.push(`- Turn: ${turn}`);
	rows.push(`- At: ${new Date().toISOString()}`, '', '## Latest model output', '');
	rows.push(body && body.trim() !== '' ? truncate(body.trim(), cfg.maxReplyChars) : '(no text captured)', '');
	atomicWriteText(join(tc.taskDir, 'process.auto.md'), rows.join('\n'));
	const recent = join(tc.taskDir, 'process.recent.md');
	try {
		if (existsSync(recent)) atomicWriteText(recent, rows.join('\n'));
	} catch {
		/* mirroring is best-effort */
	}
}

const AUTO_LOG_HEADER = '## Auto Log';

/**
 * Append one summary line for a finished turn to `process.md`, under a
 * dedicated `## Auto Log` section created on first use at the end of the
 * file. Hand-maintained sections above stay untouched; the section keeps at
 * most `cfg.maxLogEntries` entries (oldest dropped). Turns without any text
 * produce no entry. Never throws — callers guard, this keeps the invariant.
 */
function appendProcessLog(tc, cfg, { phase, turn, body }) {
	if (!body || body.trim() === '') return;
	const turnTag = Number.isFinite(turn) ? ` turn ${turn}` : '';
	const line = `- ${new Date().toISOString()}${turnTag} (${phase}): ${summarize(body.trim(), cfg.maxLogChars)}`;
	const path = join(tc.taskDir, 'process.md');
	let text = '';
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		text = '';
	}
	const lines = text.split('\n');
	const headerIndex = lines.findIndex((l) => l.trim() === AUTO_LOG_HEADER);
	let head;
	let entries = [];
	let tail = '';
	if (headerIndex === -1) {
		head = text.trim() === '' ? '' : `${text.replace(/\s+$/, '')}\n`;
	} else {
		let end = lines.length;
		for (let i = headerIndex + 1; i < lines.length; i++) {
			if (/^## /.test(lines[i])) { end = i; break; }
		}
		head = lines.slice(0, headerIndex + 1).join('\n');
		entries = lines.slice(headerIndex + 1, end).filter((l) => l.trim() !== '');
		tail = lines.slice(end).join('\n');
	}
	// A re-fired turn/end for the same turn replaces its stale entry.
	if (turnTag !== '') entries = entries.filter((l) => !l.includes(`${turnTag} (${phase})`));
	entries.push(line);
	if (entries.length > cfg.maxLogEntries) entries = entries.slice(entries.length - cfg.maxLogEntries);
	atomicWriteText(path, headerIndex === -1
		? `${head}\n${AUTO_LOG_HEADER}\n\n${entries.join('\n')}\n${tail}`
		: `${head}\n\n${entries.join('\n')}\n\n${tail}`);
}

/** Collapse whitespace and clamp to `limit` characters with an ellipsis. */
function summarize(text, limit) {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Read–merge–write the guard file, preserving fields owned by the Codex and
 * pi editions (`pi_compact_count`, `last_pi_session_id`, …) so runtimes
 * sharing one `.agents/state/` never clobber each other's counters. Field
 * semantics follow the Codex original: `auto_compact_count` /
 * `clear_required` / `threshold` / `last_*` bookkeeping, with pi's extra
 * runtime-specific keys passed through untouched. `preset` (optional) holds
 * already-computed counter updates from the caller — applied after the merge
 * so increments survive.
 */
function writeGuard(tc, cfg, phase, extra, preset) {
	const path = join(tc.taskDir, 'context_guard.json');
	const guard = readGuard(tc);
	Object.assign(guard, preset);
	guard.taskId = tc.taskId;
	guard.phase = phase;
	guard.at = new Date().toISOString();
	Object.assign(guard, extra);
	guard.threshold = cfg.compactThreshold;
	guard.last_updated = new Date().toISOString();
	guard.last_runtime = 'dsh';
	atomicWriteText(path, `${JSON.stringify(guard, null, 2)}\n`);
}

/** Read the guard file with Codex-default field shape; unknown keys kept. */
function readGuard(tc) {
	try {
		const loaded = JSON.parse(readFileSync(join(tc.taskDir, 'context_guard.json'), 'utf8'));
		if (loaded !== null && typeof loaded === 'object' && !Array.isArray(loaded)) {
			loaded.auto_compact_count = nonNegativeInt(loaded.auto_compact_count);
			loaded.pi_compact_count = nonNegativeInt(loaded.pi_compact_count);
			loaded.clear_required = Boolean(loaded.clear_required);
			return loaded;
		}
	} catch {
		/* missing or malformed — fall through to defaults */
	}
	return {
		auto_compact_count: 0,
		pi_compact_count: 0,
		clear_required: false,
		threshold: 3,
		last_event: '',
		last_trigger: '',
		last_source: '',
		last_turn_id: '',
		last_transcript: '',
		last_updated: '',
		last_reset_source: '',
		last_reset_at: '',
	};
}

function nonNegativeInt(value) {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? n : 0;
}

/** True when the combined compaction counters reach the clear threshold. */
function guardNeedsClear(guard, cfg) {
	const count = (guard.pi_compact_count ?? 0) + (guard.auto_compact_count ?? 0);
	return guard.clear_required || count >= cfg.compactThreshold;
}

//#endregion
