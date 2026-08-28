// Smoke test for the shared-handoff-dsh host half.
// Drives apply() with a fake Cordis ctx and fake sessions against a temp
// repo that the real bootstrap script initialized, then asserts:
//   1. turn/end writes process.auto.md (+ mirrors an existing process.recent.md)
//   2. compaction/start|summary write context_guard.json + snapshots
//   3. agent/pre-step step 1 appends a baseline user message with task state
//   4. listeners never throw on malformed input
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const plugin = await import(join(root, 'lib/index.js'));

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

const session = {
	header: { cwd: repo, id: sessionId },
	id: sessionId,
	events: [
		{ type: 'user/message', turn: 1 },
		{ type: 'assistant/message', turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Turn one reply.' }] } },
	],
};

// --- 1. turn/end writes the auto snapshot ---
sessionEvent(session, { type: 'turn/end', turn: 1, reason: 'complete' });
const auto = readFileSync(join(repo, '.agents/state/tasks/smoke-task/process.auto.md'), 'utf8');
assert.match(auto, /Phase: turn-end/);
assert.match(auto, /Turn: 1/);
assert.match(auto, /Turn one reply\./);
const recent = readFileSync(join(repo, '.agents/state/tasks/smoke-task/process.recent.md'), 'utf8');
assert.match(recent, /Phase: turn-end/, 'recent mirrors auto');

// --- 2. compaction guard ---
sessionEvent(session, { type: 'compaction/start', compactionId: 'c1', turn: 1 });
let guard = JSON.parse(readFileSync(join(repo, '.agents/state/tasks/smoke-task/context_guard.json'), 'utf8'));
assert.equal(guard.phase, 'start');
assert.equal(guard.taskId, 'smoke-task');
sessionEvent(session, { type: 'compaction/summary', compactionId: 'c1', summary: [{ type: 'text', text: 'Summary of compacted work.' }] });
guard = JSON.parse(readFileSync(join(repo, '.agents/state/tasks/smoke-task/context_guard.json'), 'utf8'));
assert.equal(guard.phase, 'summary');
const auto2 = readFileSync(join(repo, '.agents/state/tasks/smoke-task/process.auto.md'), 'utf8');
assert.match(auto2, /post-compaction/);
assert.match(auto2, /Summary of compacted work\./);

// --- 3. baseline injection on first pre-step ---
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

// second pre-step for the same session must NOT inject again
const again = await preStep({ agent, messages: [], step: 2, signal: undefined }, async () => decision);
assert.equal(again.messages.length, 1, 'no double injection');

// --- 4. robustness: malformed inputs never throw ---
assert.doesNotThrow(() => sessionEvent(undefined, { type: 'turn/end', turn: 2 }));
assert.doesNotThrow(() => sessionEvent({ header: {} }, { type: 'compaction/start' }));
assert.doesNotThrow(() => sessionEvent(session, { type: 'step/start', turn: 2, step: 3 }));
const rejectDecision = { kind: 'reject', reason: 'gate' };
const rejected = await preStep({ agent, messages: [], step: 1, signal: undefined }, async () => rejectDecision);
assert.equal(rejected, rejectDecision, 'reject decision passes through untouched');

// repo without .agents/state → no snapshot, no crash
const bareRepo = mkdtempSync(join(tmpdir(), 'handoff-bare-'));
sessionEvent({ header: { cwd: bareRepo, id: 'session-x' }, events: [] }, { type: 'turn/end', turn: 1, reason: 'complete' });
assert.ok(!existsSync(join(bareRepo, '.agents')), 'no state invented in a bare repo');

rmSync(repo, { recursive: true, force: true });
rmSync(fakeDshHome, { recursive: true, force: true });
rmSync(bareRepo, { recursive: true, force: true });
if (warnings.length > 0) console.log('warnings:', warnings);
console.log('ALL HOST-HALF SMOKE TESTS PASSED');
