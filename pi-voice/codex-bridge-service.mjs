import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { CodexRpc, safeError } from './codex-rpc.mjs';
import { BRIDGE_SOCKET, bridgeCall } from './codex-bridge-client.mjs';

const ROOT = '/data/codex-bridge';
const PROJECT_CWD = '/mnt/user/fast/home_control';
fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
fs.mkdirSync('/data/runtime', { recursive: true, mode: 0o700 });
let store;
try { store = JSON.parse(fs.readFileSync(ROOT + '/state.json', 'utf8')); } catch { store = { jobs: {}, events: [], sequence: 0 }; }
const log = message => fs.appendFileSync(ROOT + '/service.log', `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
const save = () => {
  fs.writeFileSync(ROOT + '/state.json.tmp', JSON.stringify(store), { mode: 0o600 });
  fs.renameSync(ROOT + '/state.json.tmp', ROOT + '/state.json');
};
let rpc, connecting, stopping = false;
const summaries = new Map();
const brief = thread => ({ id: thread.id, name: thread.name, preview: thread.preview?.slice(0, 700), cwd: thread.cwd, status: thread.status, createdAt: thread.createdAt, updatedAt: thread.updatedAt });
const activeJobs = () => Object.values(store.jobs).filter(x => ['inProgress', 'starting', 'needsAttention'].includes(x.status));
function event(type, job) {
  store.events.push({ seq: ++store.sequence, type, at: Date.now(), threadId: job.threadId, turnId: job.turnId, status: job.status, title: job.title, result: job.result?.slice(-16000), error: job.error, failedCommands: job.failedCommands, notify: job.notify, ownerId: job.ownerId });
  store.events = store.events.slice(-200); save();
}
function updateJob(threadId, turn) {
  const job = store.jobs[threadId]; if (!job) return;
  if (turn.id && job.turnId && turn.id !== job.turnId) return;
  job.turnId = turn.id ?? job.turnId;
  job.status = turn.status;
  job.error = turn.error?.message ? safeError(turn.error.message) : null;
  const messages = (turn.items ?? []).filter(x => x.type === 'agentMessage').map(x => x.text ?? '').filter(Boolean);
  job.result = (messages.join('\n') || summaries.get(`${threadId}:${job.turnId}`) || job.result || '').slice(-20000);
  job.failedCommands = (turn.items ?? []).filter(x => x.type === 'commandExecution' && x.status === 'failed').map(x => ({ command: safeError(x.command), exitCode: x.exitCode, output: safeError(x.aggregatedOutput ?? '') })).slice(-5);
  job.updatedAt = Date.now();
  if (['completed', 'failed', 'interrupted'].includes(job.status)) {
    const completion = `${job.turnId}:${job.status}`;
    if (job.lastCompletion !== completion) { job.lastCompletion = completion; event('completed', job); log(`turn-${job.status} thread=${threadId}`); }
  }
  save();
}
async function ensureRpc() {
  if (rpc) return rpc;
  if (connecting) return connecting;
  connecting = (async () => {
    const candidate = new CodexRpc();
    candidate.on('notification', message => {
      const p = message.params ?? {};
      if (message.method === 'item/agentMessage/delta') {
        const key = `${p.threadId}:${p.turnId}`;
        summaries.set(key, ((summaries.get(key) ?? '') + (p.delta ?? '')).slice(-20000));
      }
      if (message.method === 'item/completed' && p.item?.type === 'agentMessage' && p.item?.text) summaries.set(`${p.threadId}:${p.turnId}`, p.item.text.slice(-20000));
      if (message.method === 'turn/started' && store.jobs[p.threadId]) {
        const job = store.jobs[p.threadId]; job.turnId = p.turn.id; job.status = 'inProgress'; job.result = ''; job.updatedAt = Date.now(); save();
      }
      if (message.method === 'turn/completed') updateJob(p.threadId, p.turn);
    });
    candidate.on('serverRequest', message => {
      const id = message.params?.threadId, job = store.jobs[id];
      if (job) { job.status = 'needsAttention'; job.error = `Codex requires an interactive client: ${message.method}`; event('needsAttention', job); }
    });
    candidate.on('disconnected', error => { if (rpc === candidate) { rpc = undefined; log('daemon-disconnected ' + error); } });
    try { await candidate.connect(); rpc = candidate; log('daemon-connected'); return candidate; }
    catch (error) { candidate.close(); throw error; }
  })().finally(() => { connecting = undefined; });
  return connecting;
}
async function snapshot(threadId) {
  const api = await ensureRpc();
  const data = await api.request('thread/read', { threadId });
  const turns = await api.request('thread/turns/list', { threadId, limit: 3, itemsView: 'full', sortDirection: 'desc' });
  const latest = turns.data?.[0];
  if (latest && store.jobs[threadId]) updateJob(threadId, latest);
  const messages = (latest?.items ?? []).filter(x => x.type === 'agentMessage').map(x => x.text).filter(Boolean);
  const recentItems = (latest?.items ?? []).slice(-8).map(x => ({ type: x.type, status: x.status, ...(x.type === 'commandExecution' ? { command: safeError(x.command), exitCode: x.exitCode } : {}), ...(x.type === 'fileChange' ? { paths: x.changes?.map(c => c.path) } : {}) }));
  return { thread: brief(data.thread), latestTurn: latest ? { id: latest.id, status: latest.status, error: latest.error, result: messages.join('\n').slice(-16000), recentItems } : null, tracked: store.jobs[threadId] ?? null };
}
const checkedId = value => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{5,120}$/.test(value)) throw Error('Invalid thread ID'); return value; };
const checkedPrompt = value => { if (typeof value !== 'string' || !value.trim() || value.length > 32000) throw Error('Task prompt must contain 1–32000 characters'); return value; };
async function action(input) {
  const ownedActive = () => activeJobs().filter(j => j.status !== 'needsAttention' && (!input.ownerId || j.ownerId === input.ownerId));
  if (input.action === 'events') return { sequence: store.sequence, active: ownedActive().length, events: store.events.filter(x => x.seq > Number(input.after ?? 0) && (!input.ownerId || x.ownerId === input.ownerId)) };
  if (input.action === 'activity') return { active: ownedActive().length, jobs: ownedActive().map(j => ({ threadId: j.threadId, title: j.title, status: j.status })) };
  const api = await ensureRpc();
  if (input.action === 'ping') {
    const account = await api.request('account/read', { refreshToken: false });
    return { connected: true, authenticated: Boolean(account.account), accountType: account.account?.type, active: activeJobs().length, daemonSocket: '/data/.codex/app-server-control/app-server-control.sock' };
  }
  if (input.action === 'list') {
    const response = await api.request('thread/list', { limit: Math.min(50, Math.max(1, Number(input.limit ?? 20))), ...(input.cursor ? { cursor: input.cursor } : {}), ...(input.search ? { searchTerm: input.search } : {}) });
    return { threads: response.data?.map(brief) ?? [], nextCursor: response.nextCursor, tracked: Object.values(store.jobs).map(j => ({ threadId: j.threadId, title: j.title, status: j.status })) };
  }
  if (input.action === 'create') {
    const prompt = checkedPrompt(input.prompt);
    const requested = path.resolve(input.cwd ?? PROJECT_CWD);
    if (![PROJECT_CWD, '/workspace/home_control'].includes(requested)) throw Error(`Codex work directory is fixed to ${PROJECT_CWD}`);
    const cwd = PROJECT_CWD;
    if (!fs.statSync(cwd).isDirectory()) throw Error('Work directory does not exist');
    const created = await api.request('thread/start', { model: input.model ?? 'gpt-6.1-sol', cwd,
      sandbox: 'danger-full-access', approvalPolicy: 'never',
      developerInstructions: '用户通过Pi语音助手委派此任务，直接在现有Docker容器内执行，不启用Codex内层沙箱，不修改容器权限或宿主内核。只执行当前用户授权的任务及后续明确调整；不要自行启动语音、不要访问或输出凭据。最终明确说明实际完成的工作、验证结果和未完成事项。命令失败时不得声称已成功执行。',
      serviceName: 'pi-codex-bridge',
    });
    const threadId = created.thread.id;
    const title = String(input.title ?? prompt.slice(0, 60)).slice(0, 120);
    await api.request('thread/name/set', { threadId, name: title });
    store.jobs[threadId] = { threadId, title, cwd, codexSandboxDisabled: true, status: 'starting', notify: input.notify !== false, ownerId: input.ownerId, createdAt: Date.now(), updatedAt: Date.now(), result: '' }; save();
    try {
      const started = await api.request('turn/start', { threadId, cwd: PROJECT_CWD, input: [{ type: 'text', text: prompt }], sandboxPolicy: { type: 'dangerFullAccess' } });
      const job = store.jobs[threadId]; job.turnId = started.turn.id; job.status = started.turn.status; save();
      return { accepted: true, threadId, turnId: job.turnId, status: job.status, cwd, title };
    } catch (error) { const job = store.jobs[threadId]; job.status = 'failed'; job.error = safeError(error); event('completed', job); throw error; }
  }
  const threadId = checkedId(input.threadId);
  if (input.action === 'status' || input.action === 'read') return snapshot(threadId);
  if (input.action === 'watch') {
    const resumed = await api.request('thread/resume', { threadId, cwd: PROJECT_CWD, excludeTurns: true });
    const old = store.jobs[threadId];
    store.jobs[threadId] = { ...old, threadId, ownerId: input.ownerId ?? old?.ownerId, title: resumed.thread.name ?? resumed.thread.preview?.slice(0, 60), cwd: resumed.thread.cwd, notify: true, status: old?.status ?? 'starting', updatedAt: Date.now() }; save();
    return snapshot(threadId);
  }
  if (input.action === 'send') {
    const prompt = checkedPrompt(input.prompt);
    // Resume attaches this connection to the SAME live thread; it does not start another app-server.
    await api.request('thread/resume', { threadId, cwd: PROJECT_CWD, excludeTurns: true });
    const current = await snapshot(threadId);
    const active = current.latestTurn?.status === 'inProgress' ? current.latestTurn : null;
    const old = store.jobs[threadId];
    store.jobs[threadId] = { ...old, threadId, cwd: PROJECT_CWD, ownerId: input.ownerId ?? old?.ownerId, title: current.thread.name ?? current.thread.preview, notify: input.notify !== false, status: 'starting', updatedAt: Date.now() }; save();
    const response = active
      ? await api.request('turn/steer', { threadId, expectedTurnId: active.id, input: [{ type: 'text', text: prompt }] })
      : await api.request('turn/start', { threadId, cwd: PROJECT_CWD, input: [{ type: 'text', text: prompt }], ...(old?.codexSandboxDisabled ? { sandboxPolicy: { type: 'dangerFullAccess' } } : {}) });
    const job = store.jobs[threadId]; job.turnId = response.turnId ?? response.turn?.id; job.status = 'inProgress'; job.result = ''; save();
    return { accepted: true, threadId, turnId: job.turnId, mode: active ? 'steer' : 'continue' };
  }
  if (input.action === 'interrupt') {
    const current = await snapshot(threadId);
    if (current.latestTurn?.status !== 'inProgress') return { interrupted: false, status: current.latestTurn?.status ?? 'idle' };
    await api.request('turn/interrupt', { threadId, turnId: current.latestTurn.id });
    return { requested: true, threadId, turnId: current.latestTurn.id };
  }
  throw Error('Unknown Codex action');
}
// Reconcile tracked work after reconnect/restart; event delivery need not be continuous.
let reconciling = false;
const reconcileTimer = setInterval(async () => {
  if (reconciling || stopping) return; reconciling = true;
  try {
    for (const job of activeJobs()) {
      const api = await ensureRpc();
      await api.request('thread/resume', { threadId: job.threadId, cwd: PROJECT_CWD, excludeTurns: true });
      await snapshot(job.threadId);
    }
  } catch (error) { log('reconcile-error ' + safeError(error)); }
  finally { reconciling = false; }
}, 3000);

if (fs.existsSync(BRIDGE_SOCKET)) {
  let running = false; try { await bridgeCall({ action: 'activity' }, 500); running = true; } catch {}
  if (running) throw Error('Codex bridge already running');
  fs.unlinkSync(BRIDGE_SOCKET);
}
await ensureRpc();
const server = http.createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; if (body.length > 100000) request.destroy(); });
  request.on('end', async () => {
    try { const result = await action(JSON.parse(body)); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: true, result })); }
    catch (error) { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: false, error: safeError(error) })); }
  });
});
server.listen(BRIDGE_SOCKET, () => { fs.chmodSync(BRIDGE_SOCKET, 0o600); log('bridge-ready'); });
function stop() { if (stopping) return; stopping = true; clearInterval(reconcileTimer); rpc?.close(); server.close(() => { try { fs.unlinkSync(BRIDGE_SOCKET); } catch {} process.exit(0); }); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
