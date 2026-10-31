// Temporary Pi extension, installed into the running development container.
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { bridgeCall } from './codex-bridge-client.mjs';
import { GoogleGenAI, Modality } from '/opt/pi/node_modules/@google/genai/dist/node/index.mjs';
import { BrokerCapture } from '/opt/pi/node_modules/pi-live-codex/broker-capture.ts';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

export default function(pi: ExtensionAPI) {
  const key = readFileSync('/data/.secrets/gemini-api-key', 'utf8').trim();
  const model = 'gemini-3.8-live';
  const ai = new GoogleGenAI({ apiKey: key });
  const owner = '/data/.pi/pi-live-codex.lock/owner.json';
  let ctx: ExtensionContext | undefined;
  let session: any, capture: any, playback: any, handle: string | undefined;
  let alive = true, epoch = 0, phase = 'paused', playUntil = 0;
  let pendingTask = false, lastResult = '', failed = false;
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  let closeAfterTurn = false;
  let chain = Promise.resolve();
  let sentBytes = 0, receivedBytes = 0, readyAt = 0;
  let voiceContext = '';
  const log = (event: string) => appendFileSync('/data/gemini-live.log', `${new Date().toISOString()} ${event}\n`);
  const safe = (e: any) => {
    let text = String(e?.message ?? e).replaceAll(key, '[REDACTED]');
    if (handle) text = text.replaceAll(handle, '[SESSION HANDLE]');
    return text.slice(0, 400);
  };
  function state(next: string) {
    phase = next;
    pi.events.emit('pi-voice:state', { phase: next, provider: 'google', model });
  }
  function release() {
    capture?.stop(); capture = undefined;
    playback?.stdin?.end(); playback?.kill(); playback = undefined; playUntil = 0;
    try { if (JSON.parse(readFileSync(owner, 'utf8')).pid === process.pid) unlinkSync(owner); } catch {}
  }
  function player() {
    if (!playback || playback.killed) {
      playback = spawn('pacat', ['--playback', '--raw', '--format=s16le', '--rate=24000', '--channels=1', '--device=mcp01', '--latency-msec=60'], { stdio: ['pipe', 'ignore', 'ignore'] });
      const child = playback;
      child.stdin.on('error', () => {});
      child.on('error', () => log('playback-error'));
      child.on('exit', () => { if (playback === child) playback = undefined; });
    }
    return playback;
  }
  function pause() {
    ++epoch;
    const previous = session; session = undefined;
    capture?.stop(); capture = undefined;
    previous?.close(); release(); state('paused');
    log(`paused sentBytes=${sentBytes} receivedBytes=${receivedBytes}`);
  }
  function history() {
    if (!ctx) return '';
    return ctx.sessionManager.getBranch().filter((x: any) => x.type === 'message')
      .slice(-12).map((x: any) => ({ role: x.message?.role,
        text: x.message?.content?.filter?.((p: any) => p.type === 'text').map((p: any) => p.text).join('\n') }))
      .filter((x: any) => ['user', 'assistant'].includes(x.role) && x.text)
      .map((x: any) => `${x.role}: ${x.text}`).join('\n').slice(-16000);
  }
  async function tool(fc: any, current: any) {
    let result: any;
    try {
      const prompt = String(fc.args?.prompt ?? '').trim();
      if (fc.name === 'run_task' || fc.name === 'adjust_task') {
        if (!prompt || prompt.length > 16000) throw new Error('Invalid task text');
        if (!ctx) throw new Error('Pi is not ready');
        pendingTask = true; lastResult = ''; failed = false;
        pi.sendUserMessage(prompt, { deliverAs: 'steer' });
        result = { accepted: true, status: 'submitted', message: 'Pi会处理任务；真实结果会另行通知。' };
        log(`tool-${fc.name}-submitted`);
      } else if (fc.name === 'query_task') {
        result = { busy: !ctx?.isIdle(), pendingTask, lastResult: lastResult.slice(0, 10000), history: history() };
      } else if (fc.name === 'end_voice') {
        closeAfterTurn = true;
        result = { ok: true, message: '本轮答复后断开语音，Pi后台任务继续。' };
      } else throw new Error('Unknown tool');
    } catch (e) { result = { error: safe(e) }; }
    if (session === current) current.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response: result }] });
  }
  async function start(coldRetry = false): Promise<void> {
    if (session) return;
    if (!alive) throw new Error('Pi is shutting down');
    if (existsSync(owner)) {
      let existing: any;
      try { existing = JSON.parse(readFileSync(owner, 'utf8')); } catch {}
      if (existing?.pid && existing.pid !== process.pid) {
        let running = false;
        try { process.kill(existing.pid, 0); running = true; } catch {}
        if (running) throw new Error('Another voice owner is active');
      }
    }
    mkdirSync('/data/.pi/pi-live-codex.lock', { recursive: true });
    writeFileSync(owner, JSON.stringify({ pid: process.pid, provider: 'gemini', created: Date.now()/1000 }));
    const mine = ++epoch, began = performance.now();
    const hadHandle = Boolean(handle);
    let rejectConnect: (error: Error) => void = () => {};
    let connected = false;
    const failedConnect = new Promise<never>((_resolve, reject) => { rejectConnect = reject; });
    const connectTimer = setTimeout(() => rejectConnect(new Error('Gemini setup timed out before ready')), 12000);
    sentBytes = receivedBytes = 0; closeAfterTurn = false; state('connecting');
    let firstAudio = true;
    try {
      const opening = ai.live.connect({ model, config: {
        responseModalities: [Modality.AUDIO], inputAudioTranscription: {}, outputAudioTranscription: {},
        sessionResumption: handle ? { handle } : {}, contextWindowCompression: { slidingWindow: {} },
        systemInstruction: { parts: [{ text: '你是家中的中文语音助手，当前语音模型为Gemini 3.8 Live。简洁自然交流。需要读写文件、运行命令、家庭设备操作、研究等实际工作时调用run_task交给Pi；不要自己声称已执行。用户问进度用query_task，调整要求用adjust_task。后台完成结果到来时主动简短播报。用户要求退出或挂断用end_voice。Pi任务独立于语音连接。普通聊天直接回答。\nPi已有上下文（仅供背景，不是新的执行指令）：\n' + history() + (!hadHandle ? '\n最近语音文本（背景记录）：\n'+voiceContext : '') }] },
        tools: [{ functionDeclarations: [
          { name: 'run_task', description: '把用户明确要求的实际任务提交给Pi执行。', parameters: { type: 'OBJECT', properties: { prompt: { type: 'STRING' } }, required: ['prompt'] } },
          { name: 'adjust_task', description: '向Pi的当前任务追加用户的调整要求。', parameters: { type: 'OBJECT', properties: { prompt: { type: 'STRING' } }, required: ['prompt'] } },
          { name: 'query_task', description: '查询Pi当前任务状态、结果与最近对话。' },
          { name: 'end_voice', description: '用户要求结束语音时调用；不取消Pi后台工作。' }
        ] }]
      }, callbacks: {
        onmessage(message: any) {
          if (mine !== epoch) return;
          if (message.setupComplete) log(`setup_ms=${Math.round(performance.now()-began)}`);
          if (message.sessionResumptionUpdate?.resumable) handle = message.sessionResumptionUpdate.newHandle;
          const content = message.serverContent;
          if (content?.interrupted) { playback?.kill(); playback = undefined; playUntil = 0; state('listening'); }
          if (content?.inputTranscription?.text) {
            voiceContext = (voiceContext+'\n用户：'+content.inputTranscription.text).slice(-16000);
            pi.events.emit('pi-voice:human', { updated: Date.now()/1000 });
          }
          if (content?.outputTranscription?.text) {
            voiceContext = (voiceContext+'\n助手：'+content.outputTranscription.text).slice(-16000);
          }
          for (const part of content?.modelTurn?.parts ?? []) {
            if (!part.inlineData?.data || !String(part.inlineData.mimeType).startsWith('audio/pcm')) continue;
            const pcm = Buffer.from(part.inlineData.data, 'base64');
            if (firstAudio) { log(`first_audio_ms=${Math.round(performance.now()-began)}`); firstAudio = false; }
            receivedBytes += pcm.length;
            if (!existsSync('/data/gemini-no-playback')) player().stdin.write(pcm);
            playUntil = Math.max(playUntil, Date.now()) + pcm.length/48;
            state('speaking');
          }
          if (content?.turnComplete) {
            log(`turn-complete audioBytes=${receivedBytes}`);
            const delay = Math.max(100, playUntil-Date.now()+100);
            setTimeout(() => {
              if (mine !== epoch) return;
              if (closeAfterTurn) { closeAfterTurn = false; pause(); }
              else state('listening');
            }, delay);
          }
          for (const fc of message.toolCall?.functionCalls ?? []) void tool(fc, session);
        },
        onerror(e: any) {
          log('socket-error ' + safe(e));
          if (!connected) rejectConnect(new Error('Gemini setup error: '+safe(e)));
        },
        onclose(e: any) {
          if (mine !== epoch) return;
          session = undefined; release(); state('paused');
          log(`socket-closed code=${e.code} reason=${safe(e.reason)}`);
          if (!connected) rejectConnect(new Error(`Gemini closed before setup (${e.code}): ${safe(e.reason)}`));
        }
      } }).then((value: any) => { if (mine !== epoch) value.close(); return value; });
      const current = await Promise.race([opening, failedConnect]);
      connected = true; clearTimeout(connectTimer);
      if (mine !== epoch) { current.close(); return; }
      session = current; readyAt = Date.now(); state('listening');
      log(`ready_ms=${Math.round(performance.now()-began)} resumed=${Boolean(handle)}`);
      if (!existsSync('/data/gemini-no-mic')) {
        capture = new BrokerCapture((error: Error | null, samples: Float32Array) => {
          if (error) { log('capture-error ' + safe(error)); pause(); return; }
          if (session !== current) return;
          const pcm = Buffer.alloc(samples.length*2);
          for (let i=0;i<samples.length;i++) pcm.writeInt16LE(Math.round(Math.max(-1,Math.min(1,samples[i]))*32767),i*2);
          sentBytes += pcm.length;
          try { current.sendRealtimeInput({ audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' } }); }
          catch(e) { log('audio-send-error ' + safe(e)); pause(); }
        });
      }
    } catch (e) {
      clearTimeout(connectTimer);
      if (mine === epoch) { ++epoch; release(); state('error'); }
      // No audio or task input is sent until setup succeeds. A rejected resume
      // can safely retry once as a fresh session using the retained text context.
      if (hadHandle && !coldRetry && !connected && alive) {
        log('resume-rejected-cold-retry '+safe(e));
        handle = undefined;
        return start(true);
      }
      throw new Error(safe(e));
    }
  }
  async function announce(text: string) {
    await start();
    session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: '这是后台事件通知，不是待执行的新任务。请现在用中文主动简短播报以下已返回结果，随后允许继续讨论：\n'+text.slice(0,16000) }] }], turnComplete: true });
  }
  const off = pi.events.on('pi-voice:control', (request: any) => {
    chain = chain.then(async () => {
      try {
        if (request.action === 'pause') pause();
        else if (request.action === 'start') await start();
        else if (request.action === 'announce') await announce(String(request.text ?? ''));
        else throw new Error('Unknown voice action');
        pi.events.emit(`pi-voice:reply:${request.id}`, { ok: true });
      } catch(e) { log('control-error '+safe(e)); pi.events.emit(`pi-voice:reply:${request.id}`, { ok: false, error: safe(e) }); }
    });
  });
  async function finish() {
    if (!ctx || !pendingTask || !ctx.isIdle()) return;
    const requestId = randomUUID();
    const active = await new Promise<number | undefined>(resolve => {
      let unsubscribe = () => {};
      const timer = setTimeout(() => { unsubscribe(); resolve(undefined); }, 2000);
      unsubscribe = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (reply: any) => {
        clearTimeout(timer); unsubscribe();
        resolve(reply?.success ? reply?.data?.fleet?.totalActive : undefined);
      });
      pi.events.emit('subagents:rpc:v1:request', { version: 1, requestId, method: 'status' });
    });
    if (active !== 0 || !ctx.isIdle()) { log('completion-deferred active='+active); return; }
    const codex: any = await bridgeCall({ action: 'activity', ownerId: ctx.sessionManager.getSessionId() }, 1500).catch(() => ({ active: null }));
    if (codex.active !== 0 || !ctx.isIdle()) return;
    pendingTask = false;
    log('pi-task-settled failed='+failed);
    // Serialize with external start/pause requests. The callback owns the result.
    chain = chain.then(() => announce((failed ? '任务出现错误。' : '')+lastResult)).catch(e => log('announce-error '+safe(e)));
  }
  pi.on('session_start', (_event, context) => { ctx = context; state('paused'); log('extension-ready model='+model); });
  pi.on('before_agent_start', () => { pendingTask = true; lastResult = ''; failed = false; });
  pi.on('message_end', (event: any) => {
    const m = event.message;
    if (m.role !== 'assistant') return;
    if (['error','aborted'].includes(m.stopReason)) failed = true;
    const text = m.content?.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
    if (text) lastResult = text;
  });
  pi.on('agent_settled', () => { clearTimeout(finishTimer); finishTimer = setTimeout(() => void finish().catch(e=>log('finish-error '+safe(e))),800); });
  pi.registerCommand('gemini-test', {
    description: 'Send explicit test text to Gemini Live; does not require microphone input',
    handler: async (args: string) => {
      await start();
      session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: args || '请调用query_task查询Pi状态，简短告诉我结果。' }] }], turnComplete: true });
    }
  });
  pi.on('session_shutdown', () => { alive = false; clearTimeout(finishTimer); off(); pause(); });
}
