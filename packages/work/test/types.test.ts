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

/* ===== complex workflow type resolution ===== *
 * Each leaf contributes a DISTINCT type so a union can never silently collapse, then we
 * assert the structural group of progressively gnarlier workflows resolves EXACTLY (Equal,
 * not just assignable) — never the registry-wide union, never widened, never dropped. */

const ln = defineWork('ln', (_i: void, ctx) => ctx.result(1)); // number
const ls = defineWork('ls', (_i: void, ctx) => ctx.result('s')); // string
const lbool = defineWork('lbool', (_i: void, ctx) => ctx.result(true)); // boolean
const lbig = defineWork('lbig', (_i: void, ctx) => ctx.result(1n)); // bigint
const lobj = defineWork('lobj', (_i: void, ctx) => ctx.result({ o: 1 })); // { o: number }

// a leaf's group/self is exactly its own type — not the registry-wide union
type _leafG = Expect<Equal<GroupOfWork<ReturnType<typeof ln>>, number>>;
type _leafS = Expect<Equal<SelfOfWork<ReturnType<typeof ln>>, number>>;

// W1 — deeply nested ctx.queue unions every leaf, transitively; the root delegates ⇒ self void
const deep = defineWork('deep', (_i: void, ctx) => ctx.queue([ln(), ctx.queue([ls(), ctx.queue([lbool()])])]));
type _deepG = Expect<Equal<GroupOfWork<ReturnType<typeof deep>>, number | string | boolean>>;
type _deepS = Expect<Equal<SelfOfWork<ReturnType<typeof deep>>, void>>;

// W2 — mixed items in one queue: a leaf + an inline ctx.result + ctx.void(); void is dropped
const mixedFlow = defineWork('mixedFlow', (_i: void, ctx) => ctx.queue([ln(), ctx.result('inline'), ctx.void()]));
type _mixedG = Expect<Equal<GroupOfWork<ReturnType<typeof mixedFlow>>, number | string>>;

// W3 — chained .next accumulates each cohort's contribution (and accepts the named conditions)
const chainedFlow = defineWork('chainedFlow', (_i: void, ctx) => ctx.queue([ln()]).next([ls()]).next([lbool()], 'all-done'));
type _chainedG = Expect<Equal<GroupOfWork<ReturnType<typeof chainedFlow>>, number | string | boolean>>;

// W4 — single-item forms (no array) + a nested-queue WorkResult passed straight to .next + an object condition
const singleForms = defineWork('singleForms', (_i: void, ctx) => ctx.queue(ln()).next(ctx.queue([ls(), lbool()]), { count: 1, of: 'success' }));
type _singleG = Expect<Equal<GroupOfWork<ReturnType<typeof singleForms>>, number | string | boolean>>;

// W5 — composing sub-flows: a flow that queues OTHER flow works resolves their groups transitively
const subA = defineWork('subA', (_i: void, ctx) => ctx.queue([ln(), ls()])); // number | string
const subB = defineWork('subB', (_i: void, ctx) => ctx.queue([lbool(), lbig()])); // boolean | bigint
const orchestrate = defineWork('orchestrate', (_i: void, ctx) => ctx.queue([subA(), subB()]).next([lobj()]));
type _orchG = Expect<Equal<GroupOfWork<ReturnType<typeof orchestrate>>, number | string | boolean | bigint | { o: number }>>;
type _orchS = Expect<Equal<SelfOfWork<ReturnType<typeof orchestrate>>, void>>;

// W6 — a ctx.result root keeps its OWN self type and still widens the group via .next; final doesn't change types
const finalRoot = defineWork('finalRoot', (_i: void, ctx) => ctx.result(42, { final: true }).next([ls()]));
type _frS = Expect<Equal<SelfOfWork<ReturnType<typeof finalRoot>>, number>>; // self preserved (not void)
type _frG = Expect<Equal<GroupOfWork<ReturnType<typeof finalRoot>>, number | string>>;

// W7 — append's `existing` is typed R | undefined; self/group stay R
const appendRoot = defineWork('appendRoot', (_i: void, ctx) => ctx.result(0, { append: (existing) => (existing ?? 0) + 1 }));
type _apS = Expect<Equal<SelfOfWork<ReturnType<typeof appendRoot>>, number>>;

// W8 — duplicate contributions dedup in the union (two number leaves ⇒ number)
const dupFlow = defineWork('dupFlow', (_i: void, ctx) => ctx.queue([ln(), ln()]));
type _dupG = Expect<Equal<GroupOfWork<ReturnType<typeof dupFlow>>, number>>;

// the whole gnarly registry — enqueue must resolve each root's PRECISE structural union, end to end
const cw = createWork({ work: [ln, ls, lbool, lbig, lobj, deep, mixedFlow, chainedFlow, singleForms, subA, subB, orchestrate, finalRoot, appendRoot, dupFlow] as const, autoStart: false });

async function _complexEnqueueTyped(): Promise<void> {
  // instance form: await ⇒ the root's structural group, .result() ⇒ its own self
  const g1: number | string | boolean = await cw.enqueue(deep());
  void g1;
  const s1: void = await cw.enqueue(deep()).result(); // delegated ⇒ void
  void s1;
  const g2: number | string | boolean | bigint | { o: number } = await cw.enqueue(orchestrate()).group();
  void g2;
  const s2: number = await cw.enqueue(finalRoot()).result(); // result root keeps its self
  void s2;
  // name form resolves the same structural group
  const g3: number | string | boolean = await cw.enqueue('chainedFlow', undefined);
  void g3;

  // the group is genuinely a union, NOT collapsed to one member …
  // @ts-expect-error — deep's group is number | string | boolean, not just number
  const _bad1: number = await cw.enqueue(deep());
  void _bad1;
  // … and it is the STRUCTURAL union, not the registry-wide one (bigint is registered but deep never reaches it)
  // @ts-expect-error — bigint is not in deep's structural group
  const _bad2: bigint = await cw.enqueue(deep());
  void _bad2;
}
void _complexEnqueueTyped;

describe('type surface', () => {
  it('compiles (the assertions above are the test)', () => {
    expect(true).toBe(true);
  });
});
