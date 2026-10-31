import { readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync } from 'node:fs';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { bridgeCall } from './codex-bridge-client.mjs';

const ROUTING = `你与Live语音入口共同构成用户面对的同一个助手，Pi和Codex是内部执行组件。对用户用统一的第一人称说明正在做什么和实际结果，默认不描述“转给Pi/另一个助手”；需要工具时直接调用，不能把内部执行分工说成自身没有能力。用户询问架构时如实解释，真实工具限制仍需明确说明。
当前Pi和Codex工作目录统一为 /mnt/user/fast/home_control，直接使用用户同步的NAS项目；旧/workspace/home_control仅为历史路径，不再在那里读写任务文件。创建或续接Codex任务使用同一个当前项目目录。
执行分工是默认规则：除普通对话、无需等待的简短回答、一次简短状态查询或立即可完成的单步操作外，所有需要等待、多步操作、研究、排障、安装部署、文件/代码修改的任务，都使用 MCP 工具 mcp__shared_codex__codex_sessions 委派给共享 Codex CLI 后台执行。拿不准能否立即完成时也委派，不要先自己执行一长串工具再转交。Pi负责理解需求、必要澄清、提交任务、查询进度、调整原会话和解释结果；不要用Pi子agent代替Codex执行这些任务。用户明确指定其他执行方式时遵从用户。
可通过共享Codex的原生web_search联网查询；根据问题、已有信息和把握程度自行判断是否需要搜索，不按关键词或问题类别强制搜索。
create 仅表示已提交，绝不能当作已完成；记录返回的 threadId，正常用户任务设置notify:true。询问已有任务先 list/status/read，调整用 send，它会对运行中的回合 steer、对空闲会话续聊。不要重复 create 同一个任务，不要另开 codex exec/app-server 形成第二个后端。用户希望其他客户端的任务完成后叫他时，用watch订阅指定会话。收到 codex-completion 时根据真实结果给出适合口播的简短中文通知，说明任务和实际结果；这会触发自动恢复Live并主动播报，不需要用户先开口。不重新运行任务；未完成、失败或中断必须如实说明。不要为了等待任务阻塞语音，语音断开不取消任务。详细流程见 codex-control skill。`;

export default function(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined, ownerId = '', cursor = 0, cursorPath = '', alive = true, polling = false, lastPollError = false;
  const log = (message: string) => appendFileSync('/data/codex-bridge/pi.log', `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  const saveCursor = () => { writeFileSync(cursorPath + '.tmp', JSON.stringify({ sequence: cursor }), { mode: 0o600 }); renameSync(cursorPath + '.tmp', cursorPath); };
  pi.on('before_agent_start', event => ({ systemPrompt: event.systemPrompt + '\n\n' + ROUTING }));
  pi.on('session_start', (_event, context) => {
    ctx = context; ownerId = context.sessionManager.getSessionId();
    writeFileSync('/data/runtime/pi-workspace.json', JSON.stringify({ cwd: context.cwd, processCwd: process.cwd(), sessionCwd: context.sessionManager.getCwd(), sessionId: ownerId, updated: Date.now() / 1000 }));
    pi.registerMcpServer('shared_codex', {
      command: 'node', args: ['/data/codex-mcp.mjs'], env: { PI_CODEX_OWNER_ID: ownerId }, exposure: 'direct', timeout: 40,
      description: '共享Codex CLI后台任务：复杂工作委派、跨端查询、同会话调整和完成通知。',
    });
    mkdirSync('/data/codex-bridge', { recursive: true, mode: 0o700 });
    cursorPath = `/data/codex-bridge/pi-cursor-${ownerId.replace(/[^a-zA-Z0-9_-]/g, '')}.json`;
    try { cursor = Number(JSON.parse(readFileSync(cursorPath, 'utf8')).sequence) || 0; } catch {}
    log('extension-ready session=' + ownerId);
  });
  const offStatus = pi.events.on('codex-bridge:status', async (request: any) => {
    try { pi.events.emit(`codex-bridge:reply:${request.id}`, await bridgeCall({ action: 'activity', ownerId }, 1500)); }
    catch (error: any) { pi.events.emit(`codex-bridge:reply:${request.id}`, { active: null, error: error.message }); }
  });
  async function poll() {
    if (!alive || !ctx || !ownerId || polling) return; polling = true;
    try {
      const result: any = await bridgeCall({ action: 'events', ownerId, after: cursor }, 2000);
      for (const event of result.events) {
        if (!alive) break;
        if (event.notify && ['completed', 'needsAttention'].includes(event.type)) {
          pi.sendMessage({ customType: 'codex-completion', content: `共享 Codex 任务通知（不是新的执行请求，不要重复任务）：\n${JSON.stringify(event)}`, display: true }, { triggerTurn: true, deliverAs: 'followUp' });
          log(`completion-delivered seq=${event.seq} thread=${event.threadId} status=${event.status}`);
        }
      }
      if (cursor !== result.sequence) { cursor = result.sequence; if (alive) saveCursor(); }
    } catch (error: any) { if (!lastPollError) { log('poll-error ' + error.message); lastPollError = true; } return; }
    finally { polling = false; }
    lastPollError = false;
  }
  const timer = setInterval(() => void poll(), 1000);
  pi.registerCommand('codex-status', { description: '查看共享Codex后端和当前后台任务', handler: async (_args, context) => {
    const result = await bridgeCall({ action: 'activity', ownerId }); context.ui.notify(JSON.stringify(result), 'info');
  } });
  pi.on('session_shutdown', () => { alive = false; clearInterval(timer); offStatus(); });
}
