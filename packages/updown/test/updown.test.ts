import { describe, it, expect, vi } from 'vitest';
import {
  updown,
  list as defaultList,
  register as defaultRegister,
  up as defaultUp,
  down as defaultDown,
  whenDown as defaultWhenDown,
  isReady as defaultIsReady,
  isLive as defaultIsLive,
  type ProcessLike,
} from '../src/index';

const tick = () => new Promise((r) => setTimeout(r, 5));

/** A component that records `<phase>:<name>` into `log` for each hook. */
function recorder(log: string[], name: string, deps: string[] = []) {
  return {
    name,
    deps,
    up: () => void log.push(`up:${name}`),
    pre: () => void log.push(`pre:${name}`),
    post: () => void log.push(`post:${name}`),
  };
}

describe('ordering', () => {
  it('starts in dependency order and shuts down pre-then-post in reverse', async () => {
    const log: string[] = [];
    const lc = updown({ signals: false });
    lc.register(recorder(log, 'db'));
    lc.register(recorder(log, 'cache'));
    lc.register(recorder(log, 'http', ['db', 'cache']));

    await lc.up();
    expect(log.slice(0, 2).sort()).toEqual(['up:cache', 'up:db']); // db + cache (independent) before http
    expect(log[2]).toBe('up:http');

    log.length = 0;
    await lc.down();
    // global pre phase (http before its deps), THEN global post phase (http before its deps)
    expect(log[0]).toBe('pre:http');
    expect(log.indexOf('pre:db')).toBeLessThan(log.indexOf('post:http')); // all pres before any post
    expect(log.indexOf('pre:cache')).toBeLessThan(log.indexOf('post:http'));
    expect(log[log.length - 1]).toMatch(/^post:(db|cache)$/);
    expect(log.indexOf('post:http')).toBeLessThan(log.indexOf('post:db'));
  });
});

describe('liveness & readiness', () => {
  it('isLive/isReady transition correctly across the lifecycle', async () => {
    const lc = updown({ signals: false });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    lc.register({ name: 'a', up: () => {} });
    lc.register({ name: 'b', deps: ['a'], pre: () => gate }); // pre blocks until released

    expect(lc.isLive()).toBe(false);
    expect(lc.isReady()).toBe(false);

    await lc.up();
    expect(lc.isLive()).toBe(true);
    expect(lc.isReady()).toBe(true);

    const down = lc.down(); // begins; pre phase blocks on `gate`
    await tick();
    expect(lc.isLive()).toBe(false); // flips the instant shutdown is requested
    expect(lc.isReady()).toBe(true); // still ready while draining (pre not finished)

    release();
    await down;
    expect(lc.isReady()).toBe(false); // flips once pre finishes / post runs
    expect(lc.isLive()).toBe(false);
  });
});

describe('list()', () => {
  it('reports each component, its deps, and status', async () => {
    const lc = updown({ signals: false });
    lc.register({ name: 'db', up: () => {} });
    lc.register({ name: 'http', deps: ['db'], up: () => {}, post: () => {} });
    expect(lc.list()).toEqual([
      { name: 'db', deps: [], status: 'idle' },
      { name: 'http', deps: ['db'], status: 'idle' },
    ]);
    await lc.up();
    expect(lc.list().map((c) => c.status)).toEqual(['up', 'up']);
    await lc.down();
    expect(lc.list().map((c) => c.status)).toEqual(['down', 'down']);
  });
});

describe('validation', () => {
  it('detects dependency cycles', () => {
    const lc = updown({ signals: false });
    lc.register({ name: 'a', deps: ['b'] });
    lc.register({ name: 'b', deps: ['a'] });
    expect(() => lc.up()).toThrow(/cycle/);
  });
  it('rejects unknown dependencies', () => {
    const lc = updown({ signals: false });
    lc.register({ name: 'a', deps: ['missing'] });
    expect(() => lc.up()).toThrow(/unknown component/);
  });
  it('rejects duplicate names', () => {
    const lc = updown({ signals: false });
    lc.register({ name: 'a' });
    expect(() => lc.register({ name: 'a' })).toThrow(/duplicate/);
  });
  it('rejects registration after up()', async () => {
    const lc = updown({ signals: false });
    lc.register({ name: 'a', up: () => {} });
    void lc.up();
    expect(() => lc.register({ name: 'b' })).toThrow(/after up/);
  });
});

describe('failures', () => {
  it('up() rejects and marks the component failed', async () => {
    const lc = updown({ signals: false });
    lc.register({ name: 'x', up: () => Promise.reject(new Error('boom')) });
    await expect(lc.up()).rejects.toThrow('boom');
    expect(lc.list()[0]!.status).toBe('failed');
    expect(lc.list()[0]!.error).toBeInstanceOf(Error);
    expect(lc.isLive()).toBe(false);
  });

  it('shutdown is best-effort: a throwing hook is reported but others still run', async () => {
    const onError = vi.fn();
    const log: string[] = [];
    const lc = updown({ signals: false, onError });
    lc.register({ name: 'bad', post: () => Promise.reject(new Error('close failed')) });
    lc.register({ name: 'good', post: () => void log.push('post:good') });
    await lc.up();
    await lc.down(); // resolves despite the error
    expect(onError).toHaveBeenCalledOnce();
    expect(log).toEqual(['post:good']);
    expect(lc.list().find((c) => c.name === 'bad')!.status).toBe('failed');
  });

  it('bounds shutdown with timeout and resolves even if a hook hangs', async () => {
    const onError = vi.fn();
    const lc = updown({ signals: false, timeout: 50, onError });
    lc.register({ name: 'hang', post: () => new Promise<void>(() => {}) }); // never resolves
    await lc.up();
    await lc.down(); // must still resolve
    expect(onError).toHaveBeenCalled();
  });
});

describe('idempotency & whenDown', () => {
  it('up() and down() return the same promise on repeat calls', async () => {
    const lc = updown({ signals: false });
    lc.register({ name: 'a', up: () => {} });
    expect(lc.up()).toBe(lc.up());
    await lc.up();
    expect(lc.down()).toBe(lc.down());
  });

  it('whenDown() resolves on shutdown without triggering it', async () => {
    const lc = updown({ signals: false });
    lc.register({ name: 'a', up: () => {} });
    await lc.up();
    let resolved = false;
    void lc.whenDown().then(() => (resolved = true));
    await tick();
    expect(resolved).toBe(false); // not triggered
    await lc.down();
    await tick();
    expect(resolved).toBe(true);
  });
});

describe('signals', () => {
  function fakeProcess() {
    const handlers: Record<string, (() => void)[]> = {};
    const proc: ProcessLike & { fire(sig: string): void; exit: ReturnType<typeof vi.fn> } = {
      on: (e, h) => void (handlers[e] = [...(handlers[e] ?? []), h]),
      off: (e, h) => void (handlers[e] = (handlers[e] ?? []).filter((x) => x !== h)),
      exit: vi.fn(),
      fire: (sig) => handlers[sig]?.forEach((h) => h()),
    };
    return Object.assign(proc, { handlers });
  }

  it('a registered signal triggers shutdown and unwires afterward', async () => {
    const proc = fakeProcess();
    const log: string[] = [];
    const lc = updown({ process: proc, exit: false });
    lc.register({ name: 'srv', post: () => void log.push('post:srv') });
    await lc.up();
    expect(proc.handlers.SIGTERM).toHaveLength(1);
    expect(proc.handlers.SIGINT).toHaveLength(1);

    proc.fire('SIGTERM');
    await lc.whenDown();
    expect(log).toEqual(['post:srv']);
    expect(proc.handlers.SIGTERM).toHaveLength(0); // unwired on shutdown
    expect(proc.exit).not.toHaveBeenCalled(); // exit: false
  });

  it('exits the process after a signal when exit is not disabled', async () => {
    const proc = fakeProcess();
    const lc = updown({ process: proc, signals: ['SIGTERM'] });
    lc.register({ name: 'a', up: () => {} });
    await lc.up();
    proc.fire('SIGTERM');
    await lc.whenDown();
    await tick();
    expect(proc.exit).toHaveBeenCalledWith(0);
  });
});

describe('default instance', () => {
  it('exposes top-level register/list bound to a shared lifecycle', () => {
    defaultRegister({ name: 'singleton-thing' });
    expect(defaultList().some((c) => c.name === 'singleton-thing')).toBe(true);
  });

  it('exposes top-level up/down/whenDown/isReady/isLive bound to the shared lifecycle', async () => {
    // Drive the bound convenience exports end-to-end on the shared default instance.
    expect(defaultIsLive()).toBe(false);
    expect(defaultIsReady()).toBe(false);

    await defaultUp();
    expect(defaultIsLive()).toBe(true);
    expect(defaultIsReady()).toBe(true);

    let resolved = false;
    void defaultWhenDown().then(() => (resolved = true));

    await defaultDown();
    await tick();
    expect(resolved).toBe(true);
    expect(defaultIsLive()).toBe(false);
    expect(defaultIsReady()).toBe(false);
  });
});

describe('coverage edge cases', () => {
  it('withTimeout propagates rejection when a timeout is configured (down hook rejects)', async () => {
    // timeout set => withTimeout wraps; a rejecting hook must reach the reject path.
    // runPhase swallows hook errors via onError, so reject the inner work by throwing
    // outside a hook is not possible; instead exercise up() rejection under a timeout.
    const onError = vi.fn();
    const lc = updown({ signals: false, timeout: 1000, onError });
    lc.register({ name: 'x', up: () => Promise.reject(new Error('boom-up')) });
    await expect(lc.up()).rejects.toThrow('boom-up');
  });

  it('up() rejects with a timeout error when startup exceeds the bound', async () => {
    const lc = updown({ signals: false, timeout: 20 });
    lc.register({ name: 'slow', up: () => new Promise<void>(() => {}) }); // never resolves
    await expect(lc.up()).rejects.toThrow(/up\(\) timed out after 20ms/);
  });

  it('skips a never-started component during shutdown (status idle)', async () => {
    // If down() is called before up(), components are still 'idle' and pre/post are skipped.
    const log: string[] = [];
    const lc = updown({ signals: false });
    lc.register({ name: 'a', pre: () => void log.push('pre:a'), post: () => void log.push('post:a') });
    await lc.down(); // up() never ran
    expect(log).toEqual([]);
    expect(lc.list()[0]!.status).toBe('idle');
  });

  it('does not start new components if shutdown is requested mid-startup', async () => {
    const log: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    const lc = updown({ signals: false });
    lc.register({ name: 'a', up: () => gateA });
    lc.register({ name: 'b', deps: ['a'], up: () => void log.push('up:b') });

    const upP = lc.up();
    await tick();
    const downP = lc.down(); // requests shutdown while 'a' is still starting
    releaseA();
    await upP;
    await downP;
    // 'b' depends on 'a'; shutdown was requested before 'b' could start, so it is skipped.
    expect(log).not.toContain('up:b');
  });

  it('does nothing when the injected process has no on() method', async () => {
    // proc without .on => wireSignals early-returns; up()/down() still work.
    const proc: ProcessLike = { exit: vi.fn() };
    const lc = updown({ process: proc });
    lc.register({ name: 'a', up: () => {} });
    await lc.up();
    await lc.down();
    expect(lc.isLive()).toBe(false);
  });
});
