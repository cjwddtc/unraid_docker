// Public API transports only. No Codex OAuth, WebRTC, or sideband connection.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import WebSocket from '/opt/pi/node_modules/ws/wrapper.mjs';

const taskTools = [
  ['run_task', '使用你的agent能力执行用户要求的工作，包括连接设备、文件操作和联网查询。', true],
  ['adjust_task', '向你正在执行的任务追加调整要求。', true],
  ['query_task', '查询你当前任务的实际进度和结果。', false],
  ['end_voice', '用户要求结束语音时调用，后台任务继续。', false],
].map(([name, description, prompt]) => ({ type: 'function', function: { name, description,
  parameters: { type: 'object', properties: prompt ? { prompt: { type: 'string' } } : {}, required: prompt ? ['prompt'] : [] },
} }));

export class WsLiveTransport {
  constructor(options) {
    this.options = options;
    this.provider = options.provider ?? 'openai';
    if (!['openai', 'qwen'].includes(this.provider)) throw Error('Unsupported WebSocket provider');
    this.key = fs.readFileSync(`/data/.secrets/${this.provider === 'openai' ? 'openai-api-key' : 'dashscope-api-key'}`, 'utf8').trim();
    if (!this.key) throw Error('API key file is empty');
    this.model = options.model ?? (this.provider === 'openai' ? 'gpt-live-1' : 'qwen3.8-omni-flash-realtime');
    this.outputRate = this.provider === 'openai' ? 16000 : 24000;
    this.closed = false; this.ready = false;
    this.pendingCalls = new Map(); this.waitingOutputs = new Set(); this.toolOutputs = [];
    this.responseActive = false; this.pendingAnnouncements = [];
  }
  safe(error) { return String(error?.message ?? error).replaceAll(this.key, '[REDACTED]').slice(0, 400); }
  send(event) {
    if (this.socket?.readyState !== WebSocket.OPEN || this.closed) throw Error('Live WebSocket is not open');
    this.socket.send(JSON.stringify({ event_id: randomUUID(), ...event }));
  }
  async connect() {
    let endpoint = 'wss://api.openai.com/v1/live/sessions';
    if (this.provider === 'qwen') {
      const { workspaceId, region } = this.options;
      if (!/^[a-zA-Z0-9-]+$/.test(workspaceId ?? '')) throw Error('Qwen workspaceId is required');
      if (!['cn-beijing', 'ap-southeast-1'].includes(region)) throw Error('Qwen region must be cn-beijing or ap-southeast-1');
      endpoint = `wss://${workspaceId}.${region}.maas.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(this.model)}`;
    }
    const started = performance.now();
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = error => {
        const safe = new Error(this.safe(error));
        if (!settled) { settled = true; clearTimeout(timer); reject(safe); }
        else if (!this.closed) this.options.onEvent({ type: 'error', message: safe.message });
      };
      const timer = setTimeout(() => { fail('Live setup timed out after 12 seconds'); this.socket?.terminate(); }, 12000);
      const socket = this.socket = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${this.key}` }, handshakeTimeout: 10000 });
      socket.on('error', fail);
      socket.on('unexpected-response', (_request, response) => { response.resume(); fail(`Live WebSocket HTTP ${response.statusCode}`); socket.terminate(); });
      socket.on('open', () => {
        this.options.onEvent({ type: 'timing', step: 'socket', ms: Math.round(performance.now() - started) });
        if (this.closed) { socket.close(); return; }
        if (this.provider === 'openai') this.send({ type: 'session.start', session: {
          model: this.model, instructions: this.options.instructions,
          audio: { format: { type: 'audio/pcm', rate: 16000 }, output: { voice: this.options.voice ?? 'marin' } },
          delegation: { type: 'client' },
        } });
      });
      socket.on('message', bytes => {
        let event; try { event = JSON.parse(bytes); } catch { return; }
        if (event.type === 'error') { fail(event.error?.message ?? event.message ?? 'Live API error'); return; }
        if (this.closed && event.type !== 'session.closed') return;
        if (this.provider === 'qwen' && event.type === 'session.created') this.send({ type: 'session.update', session: {
          modalities: ['text', 'audio'], instructions: this.options.instructions,
          input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
          audio: { input: { format: { type: 'pcm', sample_rate: 16000, sample_format: 's16le', channels: 1, packing: 'interleaved', channel_layout: 'mono' } },
            output: { voice: this.options.voice ?? 'Tina', format: { type: 'pcm', sample_rate: 24000 } } },
          turn_detection: { type: 'semantic_vad_ec' }, tools: taskTools, tool_choice: 'auto',
        } });
        if ((this.provider === 'openai' && event.type === 'session.started') || (this.provider === 'qwen' && event.type === 'session.updated')) {
          if (!settled) {
            this.ready = true; settled = true; clearTimeout(timer);
            this.options.onEvent({ type: 'timing', step: 'ready', ms: Math.round(performance.now() - started) }); resolve();
          }
        }
        if (['session.output_audio.delta', 'response.audio.delta'].includes(event.type)) this.options.onEvent({ type: 'audio', pcm: Buffer.from(event.delta, 'base64'), rate: this.outputRate });
        if (['session.input_transcript.delta', 'session.output_transcript.delta'].includes(event.type)) this.options.onEvent({ type: 'transcript', role: event.type.includes('input_') ? 'user' : 'assistant', text: event.delta, startMs: event.start_ms, endMs: event.end_ms });
        if (event.type === 'conversation.item.input_audio_transcription.completed') this.options.onEvent({ type: 'transcript', role: 'user', text: event.transcript });
        if (event.type === 'response.audio_transcript.delta') this.options.onEvent({ type: 'transcript', role: 'assistant', text: event.delta });
        if (event.type === 'session.delegation.created') this.options.onEvent({ type: 'delegation', id: event.delegation?.id, offsetMs: event.offset_ms });
        if (event.type === 'response.created') this.responseActive = true;
        if (event.type === 'response.function_call_arguments.done') {
          const calls = this.pendingCalls.get(event.response_id) ?? [];
          if (!calls.some(call => call.id === event.call_id)) calls.push({ id: event.call_id, name: event.name, arguments: event.arguments });
          this.pendingCalls.set(event.response_id, calls);
        }
        if (event.type === 'input_audio_buffer.speech_started') this.options.onEvent({ type: 'interrupt' });
        if (event.type === 'response.done') {
          this.responseActive = false;
          const responseId = event.response?.id ?? event.response_id;
          const calls = this.pendingCalls.get(responseId) ?? [];
          this.pendingCalls.delete(responseId);
          // Return tool outputs only after the parent response commits its function-call items.
          for (const call of calls) this.waitingOutputs.add(call.id);
          for (const call of calls) {
            let args; try { args = JSON.parse(call.arguments || '{}'); }
            catch { this.toolResult(call.id, { error: 'Invalid JSON arguments' }); continue; }
            this.options.onEvent({ type: 'tool', id: call.id, name: call.name, args });
          }
          this.options.onEvent({ type: 'turnEnd' });
          this.flushAnnouncements();
        }
        if (event.type === 'session.closed') {
          this.options.onEvent({ type: 'usage', usage: event.usage ?? event.session?.usage }); socket.close();
        }
      });
      socket.on('close', code => {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(Error(`Live closed before setup (${code})`)); }
        this.options.onEvent({ type: 'closed', code });
      });
    });
  }
  appendAudio(pcm) {
    if (!this.ready || this.closed) return;
    if (this.socket.bufferedAmount > 256000) { this.options.onEvent({ type: 'error', message: 'Audio upload is falling behind; closing instead of building latency' }); return; }
    this.send({ type: this.provider === 'openai' ? 'session.input_audio.append' : 'input_audio_buffer.append', audio: pcm.toString('base64') });
  }
  announce(text, delegationId = null) {
    if (this.provider === 'openai') this.send({ type: 'session.commentary.append', delegation_id: delegationId, content: text.slice(0, 16000) });
    else {
      this.pendingAnnouncements.push(text.slice(0, 16000)); this.flushAnnouncements();
    }
  }
  flushAnnouncements() {
    if (this.provider !== 'qwen' || this.closed || this.responseActive || this.waitingOutputs.size || !this.pendingAnnouncements.length) return;
    const text = this.pendingAnnouncements.splice(0).join('\n');
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '这是后台已验证结果，请立即用中文简短播报，不要作为新任务执行：\n' + text }] } });
    this.responseActive = true; this.send({ type: 'response.create' });
  }
  thinking(text, delegationId = null) {
    if (this.provider === 'openai') this.send({ type: 'session.thinking.append', delegation_id: delegationId, content: text.slice(0, 16000) });
  }
  toolResult(id, result) {
    if (!this.waitingOutputs.delete(id)) throw Error('No pending tool output for this call');
    this.toolOutputs.push({ type: 'function_call_output', call_id: id, output: JSON.stringify(result) });
    if (!this.waitingOutputs.size) {
      for (const item of this.toolOutputs.splice(0)) this.send({ type: 'conversation.item.create', item });
      this.responseActive = true; this.send({ type: 'response.create' });
    }
  }
  close() {
    if (this.closed) return;
    try { if (this.provider === 'openai' && this.ready) this.send({ type: 'session.close' }); else this.socket?.close(); } catch {}
    this.closed = true; this.ready = false;
    const socket = this.socket;
    if (socket) setTimeout(() => { if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); }, 2500).unref();
  }
}
