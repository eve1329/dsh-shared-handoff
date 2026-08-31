// Smoke test for the shared-handoff-dsh host half.
// Drives apply() with a fake Cordis ctx and fake sessions against a temp
// repo that the real bootstrap script initialized, then asserts:
//   1. turn/end writes process.auto.md (+ mirrors an existing process.recent.md)
//      with the REAL DSH event shape ({ type, seq, time, data: {...} })
//   2. turn/end appends one summary line per turn to the `## Auto Log`
//      section of process.md (tool-call-only steps skipped, capped, deduped)
//   3. compaction/start|summary write context_guard.json + snapshots
//   4. agent/pre-step step 1 appends a baseline user message with task state
//   5. listeners never throw on malformed input
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const plugin = await import(join(root, 'lib/index.js'));

/** Build a session event in the real DSH shape: payload nested under `data`. */
function ev(type, data, seq = 0) {
	return Object.freeze({ type, seq, time: Date.now(), data: Object.freeze(data) });
}

// --- fixture: temp repo initialized by the REAL bootstrap script ---
const repo = mkdtempSync(join(tmpdir(), 'handoff-host-'));
const fakeDshHome = mkdtempSync(join(tmpdir(), 'handoff-home-'));
const sessionId = 'session-smoke-0001';
const transcriptDir = join(fakeDshHome, 'sessions', 'workspace-slug', sessionId);
mkdirSync(transcriptDir, { recursive: true });
const transcriptPath = join(transcriptDir, 'session.jsonl.zstd');
writeFileSync(transcriptPath, '');

execFileSync('python3', [
	join(root, 'skills/task-id-bootstrap/scripts/bootstrap_task_id.py'),
	'--repo', repo,
	'--task-id', 'smoke-task',
	'--transcript-path', transcriptPath,
]);

// process.recent.md exists from bootstrap; give process.md real content
writeFileSync(join(repo, '.agents/state/tasks/smoke-task/process.md'),
	'## Current Task\n- make the smoke test pass\n');

// --- fake ctx capturing listeners ---
const listeners = new Map();
const warnings = [];
const fakeCtx = {
	on(event, handler) { listeners.set(event, handler); },
	logger: { warn: (m) => warnings.push(m) },
};

plugin.apply(fakeCtx, { dshHome: fakeDshHome });
assert.equal(listeners.size, 2, 'two listeners registered');
const preStep = listeners.get('agent/pre-step');
const sessionEvent = listeners.get('session/event');

// Real DSH shape: turn 1 has a tool-call-only step then a text step.
const session = {
	header: { cwd: repo, id: sessionId },
	id: sessionId,
	events: [
		ev('user/message', { turn: 1 }, 0),
		ev('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'tc1', tool: 'bash' }] } }, 1),
		ev('assistant/message', { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'Turn one reply.' }] } }, 2),
	],
};

// --- 1. turn/end writes the auto snapshot (real nested event shape) ---
sessionEvent(session, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3));
const auto = readFileSync(join(repo, '.agents/state/tasks/smoke-task/process.auto.md'), 'utf8');
assert.match(auto, /Phase: turn-end/);
assert.match(auto, /Turn: 1/);
assert.match(auto, /Turn one reply\./, 'text captured across tool-call-only steps');
assert.doesNotMatch(auto, /no text captured/);
const recent = readFileSync(join(repo, '.agents/state/tasks/smoke-task/process.recent.md'), 'utf8');
assert.match(recent, /Phase: turn-end/, 'recent mirrors auto');

// --- 2. turn/end appends to the Auto Log section of process.md ---
const processMd = readFileSync(join(repo, '.agents/state/tasks/smoke-task/process.md'), 'utf8');
assert.match(processMd, /## Current Task\n- make the smoke test pass/, 'hand-written sections untouched');
assert.match(processMd, /## Auto Log\n\n- [^\n]*turn 1 \(turn-end\): Turn one reply\./, 'auto log entry appended');
assert.equal(processMd.indexOf('## Current Task') < processMd.indexOf('## Auto Log'), true, 'auto log sits after hand-written content');

// a text-less turn appends nothing
sessionEvent(session, ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, 4));
const afterEmpty = readFileSync(join(repo, '.agents/state/tasks/smoke-task/process.md'), 'utf8');
assert.doesNotMatch(afterEmpty, /turn 2/, 'empty turn leaves no auto log entry');

// later turns append below earlier ones
session.events.push(ev('assistant/message', { turn: 3, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Turn three reply.' }] } }, 5));
sessionEvent(session, ev('turn/end', { turn: 3, reason: { kind: 'completed' } }, 6));
const withThree = readFileSync(join(repo, '.agents/state/tasks/smoke-task/process.md'), 'utf8');
assert.match(withThree, /turn 1 \(turn-end\): Turn one reply\./);
assert.match(withThree, /turn 3 \(turn-end\): Turn three reply\./);
assert.equal(withThree.indexOf('turn 1') < withThree.indexOf('turn 3'), true, 'entries ordered oldest → newest');

// --- 2b. the auto log caps its length (maxLogEntries) ---
const capListeners = new Map();
plugin.apply({ on: (e, h) => capListeners.set(e, h), logger: { warn: () => {} } }, { dshHome: fakeDshHome, maxLogEntries: 2 });
const capSessionEvent = capListeners.get('session/event');
for (let t = 10; t <= 14; t++) {
	session.events.push(ev('assistant/message', { turn: t, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `Reply ${t}.` }] } }));
	capSessionEvent(session, ev('turn/end', { turn: t, reason: { kind: 'completed' } }));
}
const capped = readFileSync(join(repo, '.agents/state/tasks/smoke-task/process.md'), 'utf8');
const autoLogSection = capped.slice(capped.indexOf('## Auto Log'));
const entryCount = (autoLogSection.match(/^- /gm) || []).length;
assert.equal(entryCount, 2, `auto log capped at maxLogEntries (got ${entryCount})`);
assert.match(autoLogSection, /Reply 14\./, 'newest entry kept');
assert.doesNotMatch(autoLogSection, /Reply 10\./, 'oldest entries dropped');

// --- 3. compaction guard (payload nested under data, codex-compatible fields) ---
sessionEvent(session, ev('compaction/start', { compactionId: 'c1', turn: 1 }, 20));
let guard = JSON.parse(readFileSync(join(repo, '.agents/state/tasks/smoke-task/context_guard.json'), 'utf8'));
assert.equal(guard.phase, 'start');
assert.equal(guard.taskId, 'smoke-task');
assert.equal(guard.turn, 1);
assert.equal(guard.compactionId, 'c1');
assert.equal(guard.last_event, 'PreCompact');
assert.equal(guard.last_runtime, 'dsh');
assert.equal(guard.auto_compact_count, 0, 'start does not increment');

// interop: pi-owned fields must survive a dsh guard write
writeFileSync(join(repo, '.agents/state/tasks/smoke-task/context_guard.json'), JSON.stringify({
	auto_compact_count: 1,
	pi_compact_count: 2,
	clear_required: false,
	last_pi_session_id: 'pi-session-xyz',
	last_event: 'agent_settled',
	last_runtime: 'pi',
}));
sessionEvent(session, ev('compaction/summary', { compactionId: 'c2', summary: [{ type: 'text', text: 'Summary of compacted work.' }] }, 21));
guard = JSON.parse(readFileSync(join(repo, '.agents/state/tasks/smoke-task/context_guard.json'), 'utf8'));
assert.equal(guard.phase, 'summary');
assert.equal(guard.compactionId, 'c2');
assert.equal(guard.auto_compact_count, 2, 'dsh compaction increments the shared counter (1→2)');
assert.equal(guard.pi_compact_count, 2, 'pi-owned counter preserved');
assert.equal(guard.last_pi_session_id, 'pi-session-xyz', 'pi-owned field preserved');
assert.equal(guard.last_event, 'PostCompact');
assert.equal(guard.clear_required, false, 'below threshold: no clear required yet');

// third compaction reaches the threshold → clear_required
sessionEvent(session, ev('compaction/summary', { compactionId: 'c3', summary: [{ type: 'text', text: 'Third compaction.' }] }, 22));
guard = JSON.parse(readFileSync(join(repo, '.agents/state/tasks/smoke-task/context_guard.json'), 'utf8'));
assert.equal(guard.auto_compact_count, 3);
assert.equal(guard.clear_required, true, 'threshold reached → clear_required');
assert.equal(guard.pi_compact_count, 2, 'pi counter still preserved');
const auto2 = readFileSync(join(repo, '.agents/state/tasks/smoke-task/process.auto.md'), 'utf8');
assert.match(auto2, /post-compaction/);
assert.match(auto2, /Third compaction\./);

// --- 4. baseline injection on first pre-step ---
const decision = { kind: 'enter', messages: [{ id: 'u1', role: 'user', content: [] }] };
const agent = { session };
const enriched = await preStep({ agent, messages: [], step: 1, signal: undefined }, async () => decision);
assert.equal(enriched.kind, 'enter');
assert.equal(enriched.messages.length, 2, 'baseline appended');
const baseline = enriched.messages[1];
assert.equal(baseline.role, 'user');
assert.equal(baseline.source.plugin, 'shared-handoff-dsh');
assert.match(baseline.content[0].text, /Active task: smoke-task/);
assert.match(baseline.content[0].text, /make the smoke test pass/);
assert.match(baseline.content[0].text, /Compaction guard: summary/);
assert.match(baseline.content[0].text, /Compaction guard ALERT/, 'threshold reached → baseline carries the controlled-clear notice');
assert.match(baseline.content[0].text, /auto-compacted 5 times/, 'combined pi (2) + dsh (3) counters reported');
assert.match(baseline.content[0].text, /主动运行 `handoff`/, 'baseline carries the proactive-handoff reminder');
assert.match(baseline.content[0].text, /不要重复已完成的事项/, 'reminder also tells the model not to redo done work');

// second pre-step for the same session must NOT inject again
const again = await preStep({ agent, messages: [], step: 2, signal: undefined }, async () => decision);
assert.equal(again.messages.length, 1, 'no double injection');

// --- 5. robustness: malformed inputs never throw ---
assert.doesNotThrow(() => sessionEvent(undefined, ev('turn/end', { turn: 2 })));
assert.doesNotThrow(() => sessionEvent({ header: {} }, ev('compaction/start', {})));
assert.doesNotThrow(() => sessionEvent(session, { type: 'turn/end', turn: 2, reason: 'flat legacy shape' }), 'flat (legacy) event shape tolerated');
assert.doesNotThrow(() => sessionEvent(session, { type: 'step/start', turn: 2, step: 3 }));
const rejectDecision = { kind: 'reject', reason: 'gate' };
const rejected = await preStep({ agent, messages: [], step: 1, signal: undefined }, async () => rejectDecision);
assert.equal(rejected, rejectDecision, 'reject decision passes through untouched');

// repo without .agents/state → no snapshot, no crash
const bareRepo = mkdtempSync(join(tmpdir(), 'handoff-bare-'));
sessionEvent({ header: { cwd: bareRepo, id: 'session-x' }, events: [] }, ev('turn/end', { turn: 1 }));
assert.ok(!existsSync(join(bareRepo, '.agents')), 'no state invented in a bare repo');

// --- 6. brand-new session with no binding defaults to main and auto-binds ---
const freshRepo = mkdtempSync(join(tmpdir(), 'handoff-fresh-'));
mkdirSync(join(freshRepo, '.agents/state'), { recursive: true });
// no session-tasks.json entry, no current-task pointer, no tasks/ dir
const freshSessionId = 'session-fresh-0001';
mkdirSync(join(fakeDshHome, 'sessions', 'workspace-slug', freshSessionId), { recursive: true });
const freshTranscript = join(fakeDshHome, 'sessions', 'workspace-slug', freshSessionId, 'session.jsonl.zstd');
writeFileSync(freshTranscript, '');
const freshSession = {
	header: { cwd: freshRepo, id: freshSessionId },
	id: freshSessionId,
	events: [ev('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Fresh session reply.' }] } }, 1)],
};
sessionEvent(freshSession, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2));
const freshAuto = readFileSync(join(freshRepo, '.agents/state/tasks/main/process.auto.md'), 'utf8');
assert.match(freshAuto, /Task: main/, 'unbound new session lands on main');
assert.match(freshAuto, /Fresh session reply\./, 'snapshot written for the auto-created default task');
const freshMapping = JSON.parse(readFileSync(join(freshRepo, '.agents/state/session-tasks.json'), 'utf8'));
assert.equal(freshMapping.sessions[freshTranscript]?.task_id, 'main', 'binding auto-written for the new session');
assert.equal(freshMapping.sessions[freshTranscript]?.runtime, 'dsh');
// current-task pointer also points at main now (pi parity)
assert.equal(readFileSync(join(freshRepo, '.agents/state/current-task'), 'utf8').trim(), 'main', 'current-task defaults to main');

// a repo whose current-task points elsewhere: a new session inherits that task (pi resolution order)
const otherRepo = mkdtempSync(join(tmpdir(), 'handoff-other-'));
mkdirSync(join(otherRepo, '.agents/state/tasks/feature-x'), { recursive: true });
writeFileSync(join(otherRepo, '.agents/state/current-task'), 'feature-x');
const otherSessionId = 'session-other-0001';
mkdirSync(join(fakeDshHome, 'sessions', 'workspace-slug', otherSessionId), { recursive: true });
writeFileSync(join(fakeDshHome, 'sessions', 'workspace-slug', otherSessionId, 'session.jsonl.zstd'), '');
const otherSession = {
	header: { cwd: otherRepo, id: otherSessionId },
	id: otherSessionId,
	events: [ev('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Feature work.' }] } }, 1)],
};
sessionEvent(otherSession, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2));
const otherAuto = readFileSync(join(otherRepo, '.agents/state/tasks/feature-x/process.auto.md'), 'utf8');
assert.match(otherAuto, /Task: feature-x/, 'unbound session inherits current-task (feature-x), not main');
const otherMapping = JSON.parse(readFileSync(join(otherRepo, '.agents/state/session-tasks.json'), 'utf8'));
assert.equal(otherMapping.sessions[join(fakeDshHome, 'sessions', 'workspace-slug', otherSessionId, 'session.jsonl.zstd')]?.task_id, 'feature-x', 'inherited task auto-bound');

rmSync(repo, { recursive: true, force: true });
rmSync(fakeDshHome, { recursive: true, force: true });
rmSync(bareRepo, { recursive: true, force: true });
rmSync(freshRepo, { recursive: true, force: true });
rmSync(otherRepo, { recursive: true, force: true });
if (warnings.length > 0) console.log('warnings:', warnings);
console.log('ALL HOST-HALF SMOKE TESTS PASSED');
