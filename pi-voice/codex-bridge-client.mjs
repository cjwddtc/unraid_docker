import http from 'node:http';
export const BRIDGE_SOCKET = '/data/runtime/codex-bridge.sock';
export function bridgeCall(params, timeout = 35000) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: BRIDGE_SOCKET, path: '/', method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; if (body.length > 4000000) response.destroy(Error('Codex bridge response exceeds limit')); });
      response.on('end', () => {
        try { const value = JSON.parse(body); value.ok ? resolve(value.result) : reject(Error(value.error ?? 'Codex bridge failed')); }
        catch (error) { reject(error); }
      });
    });
    request.setTimeout(timeout, () => request.destroy(Error('Codex bridge request timed out')));
    request.on('error', reject); request.end(JSON.stringify(params));
  });
}
