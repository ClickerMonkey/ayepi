import { describe, it, expect } from 'vitest';
import { unlimitedDoer, balancedDoer, priorityDoer, ageDoer, doWith, type DoerTaskOptions, type BacklogInfo } from '../src/doer';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A harness of tasks that record their start order and block until released. */
function controllable() {
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const make = (id: string) => {
    let res!: () => void;
    const p = new Promise<void>((r) => (res = r));
    releases.set(id, res); // registered at build time, so buffered (not-yet-started) tasks can be released
    return (): Promise<void> => {
      started.push(id);
      return p;
    };
  };
  const release = (id: string): void => releases.get(id)!();
  return { started, make, release };
}

describe('doer tie-breaks & introspection', () => {
  it('unlimitedDoer reports its pull batch and an already-idle done()', async () => {
    expect(unlimitedDoer({ available: 9 }).available()).toBe(9);
    expect(unlimitedDoer().available()).toBe(256); // default batch
    await unlimitedDoer().done(); // nothing running → resolves immediately
  });

  it('balancedDoer breaks ties by priority then age then seq', async () => {
    const d = balancedDoer({ max: 1, buffer: 10 });
    const h = controllable();
    d.do(h.make('first')); // runs immediately
    d.do(h.make('hi'), { group: 'g', priority: 5, createdAt: 100 });
    d.do(h.make('older'), { group: 'g', priority: 1, createdAt: 1 });
    d.do(h.make('newer'), { group: 'g', priority: 1, createdAt: 2 });
    await tick();
    h.release('first');
    await tick(); // same group running 0 for all → priority wins
    expect(h.started.at(-1)).toBe('hi');
    h.release('hi');
    await tick(); // equal priority → older createdAt wins
    expect(h.started.at(-1)).toBe('older');
    h.release('older');
    h.release('newer');
    await d.done();
  });

  it('balancedDoer falls back to seq when group/priority/age all tie', async () => {
    const d = balancedDoer({ max: 1, buffer: 10 });
    const h = controllable();
    d.do(h.make('first'));
    d.do(h.make('t1'), { group: 'g', priority: 0, createdAt: 9 });
    d.do(h.make('t2'), { group: 'g', priority: 0, createdAt: 9 }); // identical → seq decides
    await tick();
    h.release('first');
    await tick();
    expect(h.started.at(-1)).toBe('t1');
    h.release('t1');
    h.release('t2');
    await d.done();
  });

  it('priorityDoer breaks equal priority by age then seq', async () => {
    const d = priorityDoer({ max: 1, buffer: 10 });
    const h = controllable();
    d.do(h.make('first'));
    d.do(h.make('same1'), { priority: 1, createdAt: 5 });
    d.do(h.make('same2'), { priority: 1, createdAt: 5 }); // identical → seq order
    await tick();
    h.release('first');
    await tick();
    expect(h.started.at(-1)).toBe('same1'); // earlier seq
    h.release('same1');
    h.release('same2');
    await d.done();
  });

  it('uses default buffer, the createdAt tiebreak, and done() while tasks are held', async () => {
    const d = priorityDoer({ max: 1 }); // no buffer → defaults to max
    const h = controllable();
    d.do(h.make('first'));
    d.do(h.make('old'), { priority: 1, createdAt: 1 });
    d.do(h.make('new'), { priority: 1, createdAt: 2 }); // equal priority, differing age → older first
    const donePromise = d.done(); // called while held → the pending-Promise branch of done()
    await tick();
    h.release('first');
    await tick();
    expect(h.started.at(-1)).toBe('old');
    h.release('old');
    h.release('new');
    await donePromise;
  });

  it('ageDoer breaks equal createdAt by seq', async () => {
    const d = ageDoer({ max: 1, buffer: 10 });
    const h = controllable();
    d.do(h.make('first'));
    d.do(h.make('a'), { createdAt: 7 });
    d.do(h.make('b'), { createdAt: 7 });
    await tick();
    h.release('first');
    await tick();
    expect(h.started.at(-1)).toBe('a');
    h.release('a');
    h.release('b');
    await d.done();
  });
});

describe('unlimitedDoer', () => {
  it('runs everything immediately and done() resolves', async () => {
    const d = unlimitedDoer();
    let ran = 0;
    for (let i = 0; i < 5; i++) {d.do(async () => void ran++);}
    await d.done();
    expect(ran).toBe(5);
  });
});

describe('priorityDoer', () => {
  it('runs the highest-priority pending task next', async () => {
    const d = priorityDoer({ max: 1, buffer: 10 });
    const h = controllable();
    d.do(h.make('A'), { priority: 1 }); // starts immediately (slot free)
    d.do(h.make('B'), { priority: 5 }); // buffered
    d.do(h.make('C'), { priority: 3 }); // buffered
    await tick();
    expect(h.started).toEqual(['A']);
    h.release('A');
    await tick();
    expect(h.started).toEqual(['A', 'B']); // 5 > 3
    h.release('B');
    await tick();
    expect(h.started).toEqual(['A', 'B', 'C']);
    h.release('C');
    await d.done();
  });
});

describe('ageDoer', () => {
  it('runs the oldest pending task next', async () => {
    const d = ageDoer({ max: 1, buffer: 10 });
    const h = controllable();
    d.do(h.make('A'), { createdAt: 1 }); // starts immediately
    d.do(h.make('B'), { createdAt: 3 });
    d.do(h.make('C'), { createdAt: 2 });
    await tick();
    h.release('A');
    await tick();
    expect(h.started).toEqual(['A', 'C']); // 2 older than 3
    h.release('C');
    await tick();
    expect(h.started).toEqual(['A', 'C', 'B']);
    h.release('B');
    await d.done();
  });
});

describe('balancedDoer', () => {
  it('spreads slots across groups (least-busy group next)', async () => {
    const d = balancedDoer({ max: 2, buffer: 10 });
    const h = controllable();
    const o = (group: string): DoerTaskOptions => ({ group });
    d.do(h.make('a1'), o('A')); // start
    d.do(h.make('a2'), o('A')); // start (max 2)
    d.do(h.make('a3'), o('A')); // buffered
    d.do(h.make('b1'), o('B')); // buffered
    await tick();
    expect(h.started.sort()).toEqual(['a1', 'a2']);
    h.release('a1'); // frees a slot: group B has 0 running vs A's 1 → b1 next
    await tick();
    expect(h.started).toContain('b1');
    expect(h.started).not.toContain('a3');
    h.release('a2');
    h.release('b1');
    await tick();
    h.release('a3');
    await d.done();
  });
});

describe('bounded available()', () => {
  it('decreases as tasks are held and refills as they settle', async () => {
    const d = priorityDoer({ max: 2, buffer: 2 }); // capacity 4
    const h = controllable();
    expect(d.available()).toBe(4);
    d.do(h.make('x'));
    d.do(h.make('y'));
    await tick();
    expect(d.available()).toBe(2); // 2 held
    h.release('x');
    h.release('y');
    await d.done();
    expect(d.available()).toBe(4);
  });
});

describe('doWith', () => {
  it('resolves with the task result (respecting the doer)', async () => {
    const d = unlimitedDoer();
    await expect(doWith(d, async () => 42)).resolves.toBe(42);
  });

  it('rejects when the task throws (unlike fire-and-forget do)', async () => {
    const d = unlimitedDoer();
    await expect(doWith(d, async () => { throw new Error('nope'); })).rejects.toThrow('nope');
  });

  it('forwards ordering opts to the doer', async () => {
    const d = priorityDoer({ max: 1, buffer: 10 });
    const order: string[] = [];
    const first = doWith(d, async () => { order.push('first'); }); // takes the free slot
    const lo = doWith(d, async () => { order.push('lo'); }, { priority: 1 });
    const hi = doWith(d, async () => { order.push('hi'); }, { priority: 9 });
    await Promise.all([first, lo, hi]);
    expect(order).toEqual(['first', 'hi', 'lo']); // higher priority ran before lower
  });
});

describe('bounded doer — sustained-backlog watch', () => {
  it('fires onBacklog once after the queue stays non-empty past backlogAfterMs', async () => {
    const seen: BacklogInfo[] = [];
    const d = ageDoer({ max: 1, onBacklog: (i) => seen.push(i), backlogAfterMs: 20 });
    const h = controllable();
    d.do(h.make('a')); // runs
    d.do(h.make('b')); // pending
    d.do(h.make('c')); // pending → queue non-empty (depth 2)
    await wait(45);
    expect(seen).toHaveLength(1); // fire-once (no backlogEveryMs)
    expect(seen[0]!.pending).toBe(2);
    expect(seen[0]!.running).toBe(1);
    expect(seen[0]!.nonEmptyForMs).toBeGreaterThanOrEqual(15);
    h.release('a'); await tick();
    h.release('b'); await tick();
    h.release('c'); await d.done();
  });

  it('re-fires every backlogEveryMs while still backed up', async () => {
    const seen: BacklogInfo[] = [];
    const d = ageDoer({ max: 1, onBacklog: (i) => seen.push(i), backlogAfterMs: 15, backlogEveryMs: 15 });
    const h = controllable();
    d.do(h.make('a'));
    d.do(h.make('b'));
    await wait(55); // ~fires at 15, 30, 45
    expect(seen.length).toBeGreaterThanOrEqual(2);
    h.release('a'); await tick();
    h.release('b'); await d.done();
  });

  it('does not fire if the backlog drains before the threshold', async () => {
    const seen: BacklogInfo[] = [];
    const d = ageDoer({ max: 1, onBacklog: (i) => seen.push(i), backlogAfterMs: 50 });
    const h = controllable();
    d.do(h.make('a'));
    d.do(h.make('b')); // backlog forms, timer armed for 50ms
    await tick();
    h.release('a'); await tick(); // b admitted → queue empties → timer cleared
    h.release('b'); await d.done();
    await wait(60); // past the original threshold
    expect(seen).toHaveLength(0);
  });

  it('a throwing onBacklog is swallowed and never wedges the doer', async () => {
    const d = ageDoer({ max: 1, onBacklog: () => { throw new Error('observer boom'); }, backlogAfterMs: 15 });
    const h = controllable();
    d.do(h.make('a'));
    d.do(h.make('b'));
    await wait(30); // fires + throws + swallowed
    h.release('a'); await tick();
    h.release('b'); await d.done(); // still drains cleanly
  });
});
