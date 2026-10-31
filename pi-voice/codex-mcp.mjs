// MCP stdio adapter; all calls use the existing shared daemon through the local bridge.
import readline from 'node:readline';
import { bridgeCall } from './codex-bridge-client.mjs';
import { codexTool } from './codex-tools.mjs';
import { safeError } from './codex-rpc.mjs';
const reply = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const protocols = ['2024-11-05', '2025-03-26', '2025-06-18'];
readline.createInterface({ input: process.stdin }).on('line', async line => {
  let message; try { message = JSON.parse(line); } catch { reply({ id: null, error: { code: -32700, message: 'Invalid JSON' } }); return; }
  if (message.id === undefined) return;
  try {
    if (message.method === 'initialize') reply({ id: message.id, result: { protocolVersion: protocols.includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'shared-codex-control', version: '0.1.0' } } });
    else if (message.method === 'ping') reply({ id: message.id, result: {} });
    else if (message.method === 'tools/list') reply({ id: message.id, result: { tools: [codexTool] } });
    else if (message.method === 'tools/call') {
      if (message.params?.name !== codexTool.name) throw Error('Unknown tool');
      const result = await bridgeCall({ ...message.params.arguments, ownerId: process.env.PI_CODEX_OWNER_ID ?? 'mcp' });
      reply({ id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false } });
    } else reply({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  } catch (error) { reply({ id: message.id, result: { content: [{ type: 'text', text: safeError(error) }], isError: true } }); }
});
