// A tiny stdio MCP server for the spawn tests: answers initialize and tools/list, logs to stderr, echoes its env,
// and lingers after its input ends when LINGER is set.
import { createInterface } from 'node:readline';

const send = (message) => { process.stdout.write(`${JSON.stringify(message)}\n`); };
process.stderr.write(`started in ${process.cwd()}\n`);
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1' } } });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: `echo_${process.env.ECHO_NAME ?? 'none'}`, inputSchema: { type: 'object' } }] } });
  }
});
lines.on('close', () => { if (process.env.LINGER === undefined) { process.exit(0); } else { setInterval(() => undefined, 1000); } });
