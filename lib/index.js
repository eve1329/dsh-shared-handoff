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
 *   `process.recent.md` when it exists) — the Stop hook equivalent.
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
			if (type === 'turn/end') {
				if (!cfg.autoSnapshot) return;
				const reply = lastAssistantText(session, event.turn);
				writeSnapshot(tc, cfg, { phase: 'turn-end', turn: event.turn, body: reply });
				return;
			}
			if (type === 'compaction/start') {
				if (cfg.compactionGuard) {
					writeGuard(tc, 'start', { turn: event.turn ?? null, compactionId: stringOrEmpty(event.compactionId) });
				}
				if (cfg.autoSnapshot) {
					writeSnapshot(tc, cfg, {
						phase: 'pre-compaction',
						turn: event.turn ?? undefined,
						body: lastAssistantText(session, event.turn ?? null),
					});
				}
				return;
			}
			if (cfg.compactionGuard) {
				writeGuard(tc, 'summary', { compactionId: stringOrEmpty(event.compactionId) });
			}
			if (cfg.autoSnapshot) {
				writeSnapshot(tc, cfg, { phase: 'post-compaction', body: extractText(event.summary) });
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
		compactionGuard: source.compactionGuard !== false,
		maxBaselineBytes: positiveInt(source.maxBaselineBytes, 16384),
		maxReplyChars: positiveInt(source.maxReplyChars, 4000),
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

/** Text of the last assistant message in `turn` (any turn when null). */
function lastAssistantText(session, turn) {
	const events = Array.isArray(session?.events) ? session.events : [];
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (event?.type !== 'assistant/message') continue;
		if (turn !== null && turn !== undefined && event.turn !== turn) continue;
		return extractText(event.message?.content);
	}
	return '';
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
		const guard = JSON.parse(readFileSync(join(tc.taskDir, 'context_guard.json'), 'utf8'));
		if (typeof guard?.phase === 'string' && guard.phase !== '') {
			guardNote = `\nCompaction guard: ${guard.phase} at ${guard.at ?? 'unknown time'}.`;
		}
	} catch {
		/* no guard */
	}
	return `<shared-handoff>\nActive task: ${tc.taskId}\nRepo: ${tc.cwd}${guardNote}\n\n${parts.join('\n\n')}\n</shared-handoff>`;
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

function writeGuard(tc, phase, extra) {
	atomicWriteText(join(tc.taskDir, 'context_guard.json'), `${JSON.stringify({
		taskId: tc.taskId,
		phase,
		at: new Date().toISOString(),
		...extra,
	}, null, 2)}\n`);
}

//#endregion
