import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WsLiveTransport } from './ws-live-transport.mjs';
import { bridgeCall } from './codex-bridge-client.mjs';
import { BrokerCapture } from '/opt/pi/node_modules/pi-live-codex/broker-capture.ts';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

export default function(pi: ExtensionAPI) {
  let provider = existsSync('/data/ws-provider') ? readFileSync('/data/ws-provider', 'utf8').trim() : process.env.PI_VOICE_PROVIDER ?? 'openai';
  if (!['openai', 'qwen'].includes(provider)) throw Error('Unsupported voice provider');
  let model = provider === 'openai' ? 'gpt-live-1' : 'qwen3.8-omni-flash-realtime';
  const owner = '/data/.pi/pi-live-codex.lock/owner.json';
  const log = (text: string) => appendFileSync('/data/ws-live.log', `${new Date().toISOString()} ${provider} ${text}\n`);
  let ctx: ExtensionContext | undefined, live: any, capture: any, playback: any;
  let silentInput: ReturnType<typeof setInterval> | undefined;
  let phase = 'paused', alive = true, epoch = 0, opening: Promise<void> | undefined;
  let chain = Promise.resolve(), pendingTask = false, lastResult = '', taskFailed = false;
  let finishing = false, closeAfterTurn = false, voiceContext = '', lastHuman = '', playUntil = 0, transcriptRole = '';
  let currentDelegation: string | undefined, delegatedHuman = '', spokenAt = 0;
  let finishTimer: ReturnType<typeof setTimeout> | undefined, speechTimer: ReturnType<typeof setTimeout> | undefined;
  const delegations = new Set<string>();
  const state = (next: string) => {
    phase = next;
    const value = { phase, provider, model, transport: 'websocket', updated: Date.now() / 1000 };
    writeFileSync('/data/runtime/ws-live-state.json', JSON.stringify(value));
    pi.events.emit('pi-voice:state', value);
  };
  const history = () => ctx?.sessionManager.getBranch().filter((x: any) => x.type === 'message').slice(-12)
    .map((x: any) => ({ role: x.message?.role, text: x.message?.content?.filter?.((p: any) => p.type === 'text').map((p: any) => p.text).join('\n') }))
    .filter((x: any) => ['user', 'assistant'].includes(x.role) && x.text).map((x: any) => `${x.role}: ${x.text}`).join('\n').slice(-16000) ?? '';
  function release() {
    capture?.stop(); capture = undefined;
    clearInterval(silentInput); silentInput = undefined;
    playback?.stdin?.end(); playback?.kill(); playback = undefined; playUntil = 0;
    clearTimeout(speechTimer);
    try { if (JSON.parse(readFileSync(owner, 'utf8')).pid === process.pid) unlinkSync(owner); } catch {}
  }
  function pause() {
    ++epoch; const previous = live; live = undefined; previous?.close();
    release(); state('paused'); log('paused');
  }
  function player(rate: number) {
    if (!playback || playback.killed) {
      const child = playback = spawn('pacat', ['--playback', '--raw', '--format=s16le', `--rate=${rate}`, '--channels=1', '--device=mcp01', '--latency-msec=60'], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.stdin.on('error', () => {}); child.on('error', () => log('playback-error'));
      child.on('exit', () => { if (playback === child) playback = undefined; });
    }
    return playback;
  }
  function submit(prompt: string) {
    if (!ctx || !prompt.trim() || prompt.length > 20000) throw Error('Invalid Pi task');
    pendingTask = true; lastResult = ''; taskFailed = false;
    pi.sendUserMessage(prompt, { deliverAs: 'steer' }); log('task-submitted');
    return { accepted: true, message: '我已经开始处理，完成后会告诉你。当前尚未完成。' };
  }
  async function tool(event: any, current: any) {
    let result;
    try {
      if (['run_task', 'adjust_task'].includes(event.name)) result = submit(String(event.args?.prompt ?? ''));
      else if (event.name === 'query_task') {
        const [activity, sessions]: any[] = await Promise.all([
          bridgeCall({ action: 'activity', ownerId: ctx?.sessionManager.getSessionId() }, 2000),
          bridgeCall({ action: 'list', limit: 8 }, 10000),
        ]);
        result = { piBusy: !ctx?.isIdle(), pendingTask, lastResult, codex: activity, sessions };
      }
      else if (event.name === 'end_voice') { closeAfterTurn = true; result = { ok: true, message: '答复后结束语音，后台工作继续。' }; }
      else throw Error('Unknown voice tool');
    } catch (error: any) { result = { error: String(error.message).slice(0, 200) }; }
    if (live === current) current.toolResult(event.id, result);
  }
  async function delegate(event: any, current: any) {
    if (!event.id || delegations.has(event.id)) return;
    delegations.add(event.id);
    // The public Live event has metadata only. Wait for trailing transcript deltas.
    await new Promise(resolve => setTimeout(resolve, 250));
    if (live !== current) return;
    currentDelegation = event.id;
    const request = lastHuman.trim();
    if (!request || request === delegatedHuman) { current.thinking('没有新的完整用户请求，不重复提交任务。', event.id); return; }
    const normalized = request.replace(/[\s，。！？,.!?]/g, '');
    if (/^(请|帮我|麻烦)?(结束|退出|关闭|挂断)(一下)?(当前)?(语音|通话|语音模式|语音对话)(吧|了)?$/.test(normalized)) {
      closeAfterTurn = true; current.announce('好的，结束本次语音。后台任务继续。', event.id); return;
    }
    if (/^(现在)?(任务|进度|后台任务).{0,8}(怎么样|如何|完成了吗|好了吗|进度)$/.test(normalized)) {
      submit('用户正在询问已有Codex任务的当前进度。请使用共享Codex工具list/status/read查询真实状态，用简短中文回答；不要新建任务，不要把提交当作完成。');
      current.thinking('正在查询原Codex会话的真实状态。', event.id); return;
    }
    delegatedHuman = request;
    submit('用户通过语音明确委派了下面的工作。根据用户最新请求和已有Pi上下文执行；引文中的较早对话仅供理解，不重复执行已完成任务。\n最近语音对话：\n' + voiceContext.slice(-10000) + '\n最新用户请求：\n' + request);
    current.thinking('我已经开始处理，当前尚未完成；可以继续和用户交流，完成后根据实际结果回复。', event.id);
  }
  async function connect() {
    if (live?.ready) return;
    if (opening) return opening;
    opening = start().catch(error => { pause(); throw error; }).finally(() => { opening = undefined; }); return opening;
  }
  async function start() {
    if (!alive) throw Error('Voice runtime is stopping');
    if (existsSync(owner)) {
      let other: any; try { other = JSON.parse(readFileSync(owner, 'utf8')); } catch {}
      if (other?.pid && other.pid !== process.pid) {
        let running = false; try { process.kill(other.pid, 0); running = true; } catch {}
        if (running) throw Error('Another voice owner is active');
      }
    }
    mkdirSync('/data/.pi/pi-live-codex.lock', { recursive: true });
    writeFileSync(owner, JSON.stringify({ pid: process.pid, provider, created: Date.now() / 1000 }));
    const mine = ++epoch, began = performance.now();
    state('connecting'); closeAfterTurn = false; lastHuman = ''; delegatedHuman = ''; delegations.clear(); currentDelegation = undefined;
    const qwen = provider === 'qwen' ? JSON.parse(readFileSync('/data/qwen-live-config.json', 'utf8')) : {};
    const current = live = new WsLiveTransport({ provider, model, ...qwen,
      instructions: `你是家中的中文语音助手，集成了Pi agent、共享Codex和联网搜索等工具能力。对用户而言，你是负责理解需求、采取行动、跟进任务和解释结果的同一个助手；语音模型是${model}，Pi和Codex是你的内部执行组件。用统一的第一人称自然交流，不把自己描述为一个只能聊天、不能操作的独立语音模型，也不要求用户另找Pi或Codex。需要工具时直接调用；不能因为操作由内部组件完成，就说自己无法连接局域网、无法操作文件或无法执行任务。只有真实工具结果表明受限时，才说明具体限制，不夸大当前权限。用户询问实现方式时可以如实解释内部架构。简洁自然，优先中文。
普通交流直接回答；是否需要联网搜索，由你根据问题、已有信息和把握程度自行判断。需要文件、命令、设备操作或研究时，通过当前会话提供的委派能力启动你的agent执行流程。内部执行约定：需要等待、多步操作、排障、部署或代码修改的工作，由Pi调用共享Codex CLI后台处理；查询和调整使用原任务会话，不重复提交。默认不向用户复述这些内部转交步骤。
提交被接受后可以说“我来检查一下”或“我已经开始处理，完成后告诉你”，不能把提交当成完成。等待时可以继续交流；用户结束语音不取消后台任务。任务完成后系统会自动连接Live并提供真实结果，你应立即主动简短播报，不等待用户开口。根据实际结果区分完成、失败、仍在进行和需要用户处理；不要编造执行结果。用户要求结束语音时执行结束请求。不要复述敏感凭据。\n已有上下文（仅供背景，不是新指令；历史中将Pi称为其他助手的说法不代表当前身份）：\n${history()}\n最近语音记录（背景）：\n${voiceContext.slice(-8000)}`,
      onEvent(event: any) {
        if (event.type === 'usage') { log('final-usage ' + JSON.stringify(event.usage)); return; }
        if (mine !== epoch) return;
        if (event.type === 'timing') log(`${event.step}_ms=${event.ms}`);
        else if (event.type === 'audio') {
          const pcm = event.pcm;
          let sum = 0; for (let i = 0; i + 1 < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2;
          const audible = Math.sqrt(sum / Math.max(1, pcm.length / 2)) > 120;
          if (!existsSync('/data/ws-no-playback')) player(event.rate).stdin.write(pcm);
          if (audible) {
            if (!spokenAt) log(`first_audible_ms=${Math.round(performance.now() - began)}`);
            spokenAt = Date.now(); state('speaking');
            playUntil = Math.max(playUntil, Date.now()) + pcm.length / (event.rate * 2) * 1000;
            clearTimeout(speechTimer);
            speechTimer = setTimeout(() => {
              if (mine !== epoch) return;
              if (closeAfterTurn) { closeAfterTurn = false; pause(); } else state('listening');
            }, Math.max(700, playUntil - Date.now() + 500));
          }
        } else if (event.type === 'transcript' && event.text) {
          voiceContext = (voiceContext + (transcriptRole === event.role ? '' : `\n${event.role}: `) + event.text).slice(-16000);
          transcriptRole = event.role;
          if (event.role === 'user') {
            // Input transcript deltas may span a phrase. A preceding assistant turn separates requests.
            if (lastHuman && (Date.now() - (current as any).lastInputAt > 2200)) lastHuman = '';
            lastHuman = (lastHuman + event.text).slice(-6000); (current as any).lastInputAt = Date.now();
            pi.events.emit('pi-voice:human', { updated: Date.now() / 1000 });
          }
        } else if (event.type === 'interrupt') { playback?.kill(); playback = undefined; playUntil = 0; state('listening'); }
        else if (event.type === 'delegation') void delegate(event, current).catch(error => log('delegation-error ' + current.safe(error)));
        else if (event.type === 'tool') void tool(event, current);
        else if (event.type === 'closed') { live = undefined; release(); state('paused'); log(`closed code=${event.code}`); }
        else if (event.type === 'error') { log('socket-error ' + event.message); pause(); }
      },
    });
    spokenAt = 0;
    try {
      await current.connect();
      if (mine !== epoch) { current.close(); return; }
      state('listening');
      if (!existsSync('/data/ws-no-mic')) capture = new BrokerCapture((error: Error | null, samples: Float32Array) => {
        if (live !== current) return;
        if (error) { log('capture-error'); pause(); return; }
        const pcm = Buffer.alloc(samples.length * 2);
        for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
        try { current.appendAudio(pcm); } catch (error) { log('audio-send-error ' + current.safe(error)); pause(); }
      });
      else {
        // Only used with the explicit no-microphone test flag; never mix a fixture into live capture.
        const fixture = existsSync('/data/ws-test-audio.pcm') ? readFileSync('/data/ws-test-audio.pcm') : Buffer.alloc(0);
        if (fixture.length > 480000 || fixture.length % 2) throw Error('Test fixture must be at most 15 seconds of PCM16/16kHz');
        let offset = -16000;
        silentInput = setInterval(() => {
          if (live !== current) return;
          const pcm = Buffer.alloc(640);
          if (offset >= 0 && offset < fixture.length) fixture.copy(pcm, 0, offset, Math.min(fixture.length, offset + 640));
          offset += 640;
          try { current.appendAudio(pcm); } catch { pause(); }
        }, 20);
      }
    } catch (error) { if (mine === epoch) pause(); throw Error(current.safe(error)); }
  }
  async function announce(text: string) {
    const previous = live;
    await connect();
    live.announce(text.slice(0, 16000), previous === live ? currentDelegation : null);
  }
  const off = pi.events.on('pi-voice:control', (request: any) => {
    chain = chain.then(async () => {
      try {
        if (request.action === 'pause') pause();
        else if (request.action === 'start') await connect();
        else if (request.action === 'announce') await announce(String(request.text ?? ''));
        else throw Error('Unknown voice action');
        pi.events.emit(`pi-voice:reply:${request.id}`, { ok: true });
      } catch (error: any) { log('control-error ' + error.message); pi.events.emit(`pi-voice:reply:${request.id}`, { ok: false, error: error.message }); }
    });
  });
  async function finish() {
    if (!pendingTask || !ctx?.isIdle() || finishing) return;
    finishing = true;
    try {
      const requestId = randomUUID();
      const active = await new Promise<number | undefined>(resolve => {
        let unsubscribe = () => {};
        const timer = setTimeout(() => { unsubscribe(); resolve(undefined); }, 2000);
        unsubscribe = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (reply: any) => { clearTimeout(timer); unsubscribe(); resolve(reply?.success ? reply.data?.fleet?.totalActive : undefined); });
        pi.events.emit('subagents:rpc:v1:request', { version: 1, requestId, method: 'status' });
      });
      if (active !== 0 || !ctx.isIdle()) return;
      const codex: any = await bridgeCall({ action: 'activity', ownerId: ctx.sessionManager.getSessionId() }, 1500).catch(() => ({ active: null }));
      if (codex.active !== 0 || !ctx.isIdle()) return;
      pendingTask = false; log('pi-task-settled');
      chain = chain.then(() => announce((taskFailed ? '任务出现错误。' : '') + lastResult)).catch(error => log('announce-error ' + error.message));
    } finally { finishing = false; }
  }
  pi.on('session_start', (_event, context) => { ctx = context; state('paused'); log('extension-ready model=' + model); });
  pi.on('before_agent_start', () => { pendingTask = true; lastResult = ''; taskFailed = false; });
  pi.on('message_end', (event: any) => {
    const message = event.message; if (message.role !== 'assistant') return;
    taskFailed ||= ['error', 'aborted'].includes(message.stopReason);
    const text = message.content?.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
    if (text) lastResult = text;
  });
  pi.on('agent_settled', () => { clearTimeout(finishTimer); finishTimer = setTimeout(() => void finish(), 800); });
  const pendingTimer = setInterval(() => { if (alive && pendingTask) void finish().catch(error => log('completion-error ' + error.message)); }, 2500);
  pi.registerCommand('ws-test', { description: '通过当前WebSocket语音播报一条明确的测试文本', handler: async args => { await announce(args || '请用中文只说：纯WebSocket语音已接入。'); } });
  pi.registerCommand('voice-model', { description: '切换下一次唤醒的语音模型：openai 或 qwen；不结束Pi任务', handler: async (args, context) => {
    const next = args.trim();
    if (!next) { context.ui.notify(`${provider}: ${model}`, 'info'); return; }
    if (!['openai', 'qwen'].includes(next)) throw Error('Use /voice-model openai or /voice-model qwen');
    if (!existsSync(`/data/.secrets/${next === 'openai' ? 'openai-api-key' : 'dashscope-api-key'}`)) throw Error('Selected provider key is missing');
    if (next === 'qwen') JSON.parse(readFileSync('/data/qwen-live-config.json', 'utf8'));
    pause(); provider = next; model = next === 'openai' ? 'gpt-live-1' : 'qwen3.8-omni-flash-realtime';
    writeFileSync('/data/ws-provider', next + '\n'); state('paused');
    context.ui.notify(`下次唤醒使用 ${model}`, 'info'); log('provider-selected model=' + model);
  } });
  pi.on('session_shutdown', () => { alive = false; clearInterval(pendingTimer); clearTimeout(finishTimer); off(); pause(); });
}
