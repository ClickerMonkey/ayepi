import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { McpClient } from '../src/index';
import { spawnCommand, spawnStdioClient } from '../src/node';

const SERVER = fileURLToPath(new URL('./servers/echo-stdio.mjs', import.meta.url));
const INFO = { clientInfo: { name: 'test', version: '1' } } as const;

describe('spawnStdioClient', () => {
  it('starts a server, talks to it over stdio with its env and cwd, and stops it', async () => {
    const logged: string[] = [];
    const cwd = tmpdir();
    const { transport, child, exited } = spawnStdioClient(process.execPath, [SERVER], { env: { ECHO_NAME: 'hi' }, cwd, stderr: (line) => { logged.push(line); } });
    const client = await McpClient.connect(transport, INFO);
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(['echo_hi']);
    await transport.respond({ jsonrpc: '2.0', id: 99, result: {} });
    await client.close();
    expect(await exited).toBe(0);
    expect(child.exitCode).toBe(0);
    expect(logged[0]).toContain('started in');
    await transport.close();
  });

  it('kills a server that lingers after its input ends', async () => {
    const { transport, exited } = spawnStdioClient(process.execPath, [SERVER], { env: { LINGER: '1' }, killAfter: 50 });
    const client = await McpClient.connect(transport, INFO);
    await client.close();
    expect(await exited).toBeNull();
  });

  it('fails the first request when the command cannot start', async () => {
    const { transport, exited } = spawnStdioClient('no-such-mcp-server-command-xyz');
    await expect(McpClient.connect(transport, INFO)).rejects.toThrow();
    expect(await exited).toBeNull();
  });
});

describe('spawnCommand', () => {
  it('runs a command as it is off Windows', () => {
    expect(spawnCommand('npx', ['-y', 'a b'], {}, 'linux')).toEqual({ file: 'npx', args: ['-y', 'a b'], verbatim: false });
  });

  it('finds a Windows command on PATH and runs .cmd shims through cmd.exe with quoted arguments', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-spawn-'));
    await writeFile(join(dir, 'tool.cmd'), '@echo off');
    await writeFile(join(dir, 'prog.exe'), '');
    const env = { PATH: `${dir};C:\\nowhere`, PATHEXT: '.exe;.cmd', ComSpec: 'C:\\Windows\\cmd.exe' };
    const shim = spawnCommand('tool', ['-y', 'a "b"', 'x&y', 'end\\'], env, 'win32');
    expect(shim.file).toBe('C:\\Windows\\cmd.exe');
    expect(shim.verbatim).toBe(true);
    expect(shim.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    const command = join(dir, 'tool.cmd').replace(/([()\][%!^"`<>&|;, *?])/g, '^$1');
    expect(shim.args[3]).toBe(`"${command} ^"-y^" ^"a^ \\^"b\\^"^" ^"x^&y^" ^"end\\\\^""`);
    expect(spawnCommand('prog', [], { Path: dir, PATHEXT: '.exe' }, 'win32')).toEqual({ file: join(dir, 'prog.exe'), args: [], verbatim: false });
    expect(spawnCommand(join(dir, 'tool.cmd'), [], {}, 'win32').file).toBe('cmd.exe');
    expect(spawnCommand('missing', ['a'], {}, 'win32')).toEqual({ file: 'missing', args: ['a'], verbatim: false });
  });
});
