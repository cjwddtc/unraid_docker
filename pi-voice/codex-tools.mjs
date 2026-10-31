export const codexTool = {
  name: 'codex_sessions',
  description: 'Control conversations on the ONE shared Codex CLI daemon. Delegate complex work asynchronously; list/query/continue/steer/interrupt/watch the same persistent Codex threads.',
  inputSchema: { type: 'object', properties: {
    action: { type: 'string', enum: ['ping', 'list', 'create', 'status', 'read', 'send', 'watch', 'interrupt'] },
    threadId: { type: 'string', description: 'Required for status/read/send/watch/interrupt. Obtain from list or create; never invent IDs.' },
    prompt: { type: 'string', description: 'User-authorized task or adjustment. Required for create/send.' },
    title: { type: 'string' }, cwd: { type: 'string', description: 'Fixed project directory: /mnt/user/fast/home_control. Omit to use it automatically.' },
    model: { type: 'string', description: 'Optional new-thread model; default gpt-6.1-sol.' },
    notify: { type: 'boolean', description: 'Default true. Pi will receive completion and can resume voice.' },
    limit: { type: 'integer', minimum: 1, maximum: 50 }, cursor: { type: 'string' }, search: { type: 'string' },
  }, required: ['action'], additionalProperties: false },
};
