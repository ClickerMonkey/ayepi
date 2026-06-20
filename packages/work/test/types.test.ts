import { describe, it, expect } from 'vitest';
import { defineWork, createWork, type GroupResult, type OutputOf, type InputForName } from '../src/index';

/* ---- type-level assertions ---- */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

const add = defineWork('add', (i: { a: number; b: number }) => i.a + i.b);
const greet = defineWork('greet', (i: { name: string }) => `hi ${i.name}`);
const noret = defineWork('noret', (_i: { x: number }) => undefined);

const w = createWork({ work: [add, greet, noret] as const, autoStart: false });

// builder output/input helper types
type _o1 = Expect<Equal<OutputOf<typeof add>, number>>;
type _i1 = Expect<Equal<InputForName<readonly [typeof add, typeof greet], 'greet'>, { name: string }>>;

// group result = union of non-void outputs
type G = GroupResult<readonly [typeof add, typeof greet, typeof noret]>;
type _g = Expect<Equal<G, number | string>>;

// enqueue is type-checked
void (() => {
  w.enqueue(add({ a: 1, b: 2 })); // ok: instance form
  w.enqueue('add', { a: 1, b: 2 }); // ok: name form
  // @ts-expect-error missing field
  add({ a: 1 });
  // @ts-expect-error unknown work name
  w.enqueue('nope', {});
  // @ts-expect-error wrong input type for the named work
  w.enqueue('add', { a: 'x', b: 2 });
});

async function _resultIsTyped(): Promise<void> {
  const n = await w.enqueue(add({ a: 1, b: 2 })).result();
  const _n: number = n; // .result() is typed to the item's own output
  void _n;
}
void _resultIsTyped;

describe('type surface', () => {
  it('compiles (the assertions above are the test)', () => {
    expect(true).toBe(true);
  });
});
