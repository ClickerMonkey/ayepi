import { describe, it, expect } from 'vitest';
import { defineWork, createWork, type SelfOfWork, type GroupOfWork, type InputForName, type SelfForName, type GroupForName } from '../src/index';

/* ---- type-level assertions ---- */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

const add = defineWork('add', (i: { a: number; b: number }, ctx) => ctx.result(i.a + i.b)); // S=number G=number
const greet = defineWork('greet', (i: { name: string }, ctx) => ctx.result(`hi ${i.name}`)); // S=string G=string
const noret = defineWork('noret', (_i: { x: number }, ctx) => ctx.void()); // S=void G=never
// a root that delegates: self is void, group is the union its sub-works contribute
const flow = defineWork('flow', (_i: Record<never, never>, ctx) => ctx.queue([add({ a: 1, b: 2 }), greet({ name: 'x' })])); // S=void G=number|string
// with a native dependency the group widens by the dependents
const chain = defineWork('chain', (_i: Record<never, never>, ctx) => ctx.queue([add({ a: 1, b: 2 })]).next([greet({ name: 'x' })], 'all-success')); // G=number|string

const w = createWork({ work: [add, greet, noret, flow, chain] as const, autoStart: false });

// per-work self/group helper types
type _self = Expect<Equal<SelfOfWork<ReturnType<typeof add>>, number>>;
type _group = Expect<Equal<GroupOfWork<ReturnType<typeof add>>, number>>;
type _selfFlow = Expect<Equal<SelfOfWork<ReturnType<typeof flow>>, void>>; // delegated ⇒ void
type _groupFlow = Expect<Equal<GroupOfWork<ReturnType<typeof flow>>, number | string>>; // structural union
type _groupChain = Expect<Equal<GroupOfWork<ReturnType<typeof chain>>, number | string>>;
type _groupNoret = Expect<Equal<GroupOfWork<ReturnType<typeof noret>>, never>>; // void dropped

// registry name helpers
type _i1 = Expect<Equal<InputForName<readonly [typeof add, typeof greet], 'greet'>, { name: string }>>;
type _s1 = Expect<Equal<SelfForName<readonly [typeof add, typeof greet], 'add'>, number>>;
type _g1 = Expect<Equal<GroupForName<readonly [typeof add, typeof greet], 'greet'>, string>>;

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
  const _n: number = n; // .result() is the item's own (self) output
  void _n;
  const g = await w.enqueue(flow({})).group();
  const _g: number | string = g; // .group() is the structural union
  void _g;
}
void _resultIsTyped;

describe('type surface', () => {
  it('compiles (the assertions above are the test)', () => {
    expect(true).toBe(true);
  });
});
