import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import WebSocket from '/opt/pi/node_modules/ws/wrapper.mjs';
import { ModelRuntime } from '/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js';

export const safeError = error => String(error?.message ?? error)
  .replace(/sk-[A-Za-z0-9_.-]+/g, '[REDACTED]')
  .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED JWT]').slice(0, 800);

export class CodexRpc extends EventEmitter {
  constructor() { super(); this.serial = 0; this.pending = new Map(); }
  async tokens() {
    // Pi owns refresh credentials. Do not copy refresh tokens into a second auth.json.
    const runtime = await ModelRuntime.create({ authPath: '/data/.pi/agent/auth.json', modelsPath: null, refreshOnCreate: false });
    const auth = await runtime.getAuth('openai-codex');
    const accessToken = auth?.auth?.apiKey;
    if (!accessToken) throw Error('Pi ChatGPT/Codex subscription login is unavailable');
    const claims = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'));
    const data = claims['https://api.openai.com/auth'] ?? {};
    if (!data.chatgpt_account_id) throw Error('Codex token has no account ID');
    return { accessToken, chatgptAccountId: data.chatgpt_account_id, chatgptPlanType: data.chatgpt_plan_type ?? null };
  }
  async connect({ manageAuth = true } = {}) {
    this.socket = new WebSocket('ws+unix:///data/.codex/app-server-control/app-server-control.sock:/', { handshakeTimeout: 5000 });
    this.socket.on('error', error => this.disconnect(error));
    this.socket.on('close', () => this.disconnect(Error('Codex daemon socket disconnected')));
    this.socket.on('message', bytes => {
      let message; try { message = JSON.parse(bytes); } catch { return; }
      if (message.id !== undefined && !message.method) {
        const entry = this.pending.get(message.id); if (!entry) return;
        this.pending.delete(message.id); clearTimeout(entry.timer);
        message.error ? entry.reject(Error(safeError(message.error.message))) : entry.resolve(message.result);
      } else if (message.id !== undefined) void this.serverRequest(message);
      else if (message.method) this.emit('notification', message);
    });
    await new Promise((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', reject); });
    await this.request('initialize', { clientInfo: { name: 'pi_codex_bridge', title: 'Pi Codex Bridge', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.write({ method: 'initialized' });
    const account = await this.request('account/read', { refreshToken: false });
    // Preserve an existing managed login. Otherwise lend Pi's externally managed access token.
    if (manageAuth && (!account.account || !fs.existsSync('/data/.codex/auth.json'))) await this.request('account/login/start', { type: 'chatgptAuthTokens', ...await this.tokens() });
    return this;
  }
  async serverRequest(message) {
    try {
      if (message.method === 'account/chatgptAuthTokens/refresh') this.write({ id: message.id, result: await this.tokens() });
      else {
        this.emit('serverRequest', message);
        this.write({ id: message.id, error: { code: -32601, message: 'This unattended bridge does not answer interactive requests. Use the Codex client to resolve this request.' } });
      }
    } catch (error) { this.write({ id: message.id, error: { code: -32000, message: safeError(error) } }); }
  }
  request(method, params = {}, timeout = 30000) {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`Codex RPC timed out: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  write(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw Error('Codex daemon is not connected');
    this.socket.send(JSON.stringify(message));
  }
  disconnect(error) {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear(); this.emit('disconnected', safeError(error));
  }
  close() { this.socket?.close(); }
}
