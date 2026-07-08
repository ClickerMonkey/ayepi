/**
 * `createConnectivity` — the client's online/offline source of truth: status
 * transitions with de-duped subscriber notification, `whenOnline` (immediate /
 * edge / bounded-fallback / abort), initial seeding from `navigator.onLine`, and
 * browser `online`/`offline` binding with `dispose()` teardown.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createConnectivity } from '../src/index';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => vi.unstubAllGlobals());

describe('createConnectivity — status + subscribe', () => {
  it('defaults to online and notifies subscribers only on an actual change', () => {
    const c = createConnectivity({ browser: false });
    expect(c.status).toBe('online');
    const seen: string[] = [];
    const off = c.subscribe((s) => seen.push(s));
    c.report('online'); // no change → no event
    c.report('offline'); // change
    c.report('offline'); // no change
    c.report('online'); // change
    expect(seen).toEqual(['offline', 'online']);
    off();
    c.report('offline'); // unsubscribed → not seen
    expect(seen).toEqual(['offline', 'online']);
    expect(c.status).toBe('offline');
  });

  it('honors an explicit initial status', () => {
    expect(createConnectivity({ browser: false, initial: 'offline' }).status).toBe('offline');
  });
});

describe('createConnectivity — whenOnline', () => {
  it('resolves immediately when already online', async () => {
    const c = createConnectivity({ browser: false });
    await expect(c.whenOnline()).resolves.toBeUndefined();
  });

  it('resolves on the next online edge', async () => {
    const c = createConnectivity({ browser: false, initial: 'offline' });
    let resolved = false;
    const p = c.whenOnline().then(() => (resolved = true));
    await wait(5);
    expect(resolved).toBe(false); // still offline, no fallback set
    c.report('online');
    await p;
    expect(resolved).toBe(true);
  });

  it('resolves via the bounded fallback even without an edge (anti-deadlock)', async () => {
    const c = createConnectivity({ browser: false, initial: 'offline' });
    await expect(c.whenOnline(undefined, { timeout: 5 })).resolves.toBeUndefined();
    expect(c.status).toBe('offline'); // still offline, but the wait made progress
  });

  it('rejects if the signal is already aborted', async () => {
    const c = createConnectivity({ browser: false, initial: 'offline' });
    await expect(c.whenOnline(AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects when the signal aborts mid-wait', async () => {
    const c = createConnectivity({ browser: false, initial: 'offline' });
    const ctrl = new AbortController();
    const p = c.whenOnline(ctrl.signal, { timeout: 10_000 });
    await wait(5);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('createConnectivity — browser binding', () => {
  it('seeds from navigator.onLine and follows window online/offline, then dispose() detaches', () => {
    const handlers: Record<string, (() => void)[]> = {};
    vi.stubGlobal('navigator', { onLine: false });
    vi.stubGlobal('addEventListener', (t: string, l: () => void) => void (handlers[t] ??= []).push(l));
    vi.stubGlobal('removeEventListener', (t: string, l: () => void) => void (handlers[t] = (handlers[t] ?? []).filter((x) => x !== l)));

    const c = createConnectivity();
    expect(c.status).toBe('offline'); // seeded from navigator.onLine === false
    handlers['online']!.forEach((f) => f());
    expect(c.status).toBe('online');
    handlers['offline']!.forEach((f) => f());
    expect(c.status).toBe('offline');

    c.dispose();
    expect(handlers['online']).toEqual([]); // listeners removed
    c.dispose(); // idempotent
  });

  it('skips binding when browser is disabled, and dispose() is a no-op without binding', () => {
    const added: string[] = [];
    vi.stubGlobal('addEventListener', (t: string) => void added.push(t));
    vi.stubGlobal('removeEventListener', () => {});
    const c = createConnectivity({ browser: false });
    expect(added).toEqual([]);
    c.dispose(); // exercises the unbound teardown path
  });
});
