<!--
ayepi-codec.md — reference for `@ayepi/codec`, written for coding agents.

Copy this file into any project that depends on `@ayepi/codec` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/codec`

Rich, reversible JSON. `JSON.stringify`/`parse` is lossy: it **drops** `undefined`,
**throws** on `BigInt`, **flattens** `Date`/`Map`/`Set`/`Error`/`RegExp`/`URL` into
useless shapes, and turns `NaN`/`±Infinity` into `null`. `@ayepi/codec` wraps each such
value in a small **tagged envelope** so it survives a `stringify` → `parse` round-trip,
and lets you register **custom types** the same way. It is a **zero-dependency,
standalone** package — no `@ayepi/core`, no `zod`.

```sh
pnpm add @ayepi/codec
```

```ts
import { stringify, parse } from '@ayepi/codec';

const wire = stringify({ when: new Date(), ids: new Set([1n, 2n]), missing: undefined });
const value = parse(wire);
// value.when  instanceof Date
// value.ids   instanceof Set  (of bigint)
// 'missing' in value === true && value.missing === undefined
```

Importing the package has **no side effects**.

---

## Public API surface

Everything below is exported. Type-only symbols are marked.

| Export | Kind | Summary |
| --- | --- | --- |
| `createCodec(options?)` | function | Build a `Codec` from the built-ins plus your custom types. |
| `defaultCodec` | `Codec` | A ready-made codec: all built-ins, tag key `'$t'`. |
| `stringify(value)` | function | `defaultCodec.stringify`. |
| `parse(text)` | function | `defaultCodec.parse`. |
| `builtinTypes` | `readonly TypeCodec[]` | The default type codecs, in match order. |
| `Codec` | interface | `stringify` / `parse` / `encode` / `decode`. |
| `CodecOptions` | interface | Options for `createCodec`. |
| `TypeCodec<T>` | interface | One handler for one kind of value. |
| `Recurse` | type | `(value: unknown) => unknown`, passed to `encode`/`decode`. |

### `Codec`

```ts
interface Codec {
  stringify(value: unknown): string;  // encode + JSON.stringify
  parse(text: string): unknown;       // JSON.parse + decode
  encode(value: unknown): unknown;    // value → JSON-safe value (no string step)
  decode(value: unknown): unknown;    // JSON-safe value → rich value (no parse step)
}
```

`encode`/`decode` are useful when the value is already going through a JSON channel that
stringifies for you (an HTTP body, `structuredClone` of a plain shape, `localStorage` via
your own serializer, a DB JSON column), or when you want to inspect the wire shape.

```ts
import { defaultCodec } from '@ayepi/codec';

const safe = defaultCodec.encode({ at: new Date(0) });
// { at: { $t: 'Date', value: '1970-01-01T00:00:00.000Z' } }
JSON.stringify(safe);                     // hand off to any JSON sink
defaultCodec.decode(safe);                // { at: Date }
```

### `createCodec(options?)`

```ts
interface CodecOptions {
  readonly types?: readonly TypeCodec[];   // your custom codecs (default: none)
  readonly replaceBuiltins?: boolean;      // use `types` INSTEAD of the built-ins (default: false)
  readonly tagKey?: string;                // sentinel key in the wrapper (default: '$t')
}

function createCodec(options?: CodecOptions): Codec;
```

- By default your `types` are **prepended before** the built-ins, so a custom codec can
  override a built-in (see *Precedence* below).
- `replaceBuiltins: true` drops the built-ins entirely — only your `types` are active.
- `tagKey` changes the wrapper key (e.g. to avoid colliding with a domain field, though
  collisions are handled automatically — see *Collision escape*).

---

## Built-in types

`builtinTypes`, in order. Each is a `TypeCodec`. `null`, booleans, finite numbers,
strings, plain arrays, and plain objects match **no** codec and pass through untouched.

| Value | `tag` | Wire `value` (payload) |
| --- | --- | --- |
| `undefined` | `undefined` | `0` (ignored on decode) |
| `NaN` / `Infinity` / `-Infinity` | `Number` | `'NaN'` / `'Infinity'` / `'-Infinity'` |
| `bigint` | `BigInt` | decimal string, e.g. `'123'` |
| `Date` | `Date` | ISO string |
| `Map` | `Map` | `[[key, value], …]` (keys & values recursed) |
| `Set` | `Set` | `[value, …]` (values recursed) |
| `Error` | `Error` | `{ name, message, stack? }` |
| `RegExp` | `RegExp` | `{ source, flags }` |
| `URL` | `URL` | `href` string |

Notes:

- **`undefined`** is preserved everywhere — as an object property *and* as an array hole
  (plain JSON would turn an array `undefined` into `null` and drop object keys).
- **Number specials**: only non-finite numbers are tagged; finite numbers stay bare.
- **`Error`**: `name`, `message`, and `stack` are preserved. If the source error had **no
  `stack`**, the decoded error has **no `stack`** either (the freshly synthesized one is
  removed) — round-trip is exact. A decoded error is always a base `Error` instance with
  the original `name` (subclass identity like `TypeError` is not reconstructed).

---

## Wire format

A value handled by a codec serializes as a two-key object:

```json
{ "$t": "<tag>", "value": <payload> }
```

Encoding is **recursive**: arrays are mapped, plain objects are walked key-by-key, and a
codec's payload may itself contain encoded values (e.g. a `Map` of `Date`s). So arbitrarily
nested mixes round-trip:

```ts
import { stringify, parse } from '@ayepi/codec';

const value = {
  ids: new Set([1n, 2n]),
  byDay: new Map([['2026-06-14', [new Date(), undefined]]]),
  rx: /ab+c/gi,
  where: new URL('https://example.com/x?q=1'),
  bad: Number.NaN,
};
const back = parse(stringify(value)); // every field reconstructed to its original type
```

---

## Collision escape

If a **plain object** legitimately owns a property named exactly `tagKey` (default `'$t'`),
it is indistinguishable on the wire from a real wrapper. The codec detects this and wraps
such objects in a reserved **escape** envelope (`{ "$t": "$escape", "value": <encoded
object> }`), then unwraps them on decode. The escape is transparent:

```ts
import { stringify, parse } from '@ayepi/codec';

parse(stringify({ $t: 'hello' }));
// → { $t: 'hello' }   ✅ (NOT interpreted as a tag)

parse(stringify({ $t: 'Date', value: new Date(0), other: 1 }));
// → { $t: 'Date', value: Date(0), other: 1 }   ✅ nested rich values still work
```

You do **not** need to choose an exotic `tagKey` to be safe; the escape makes any key safe.
(`'$escape'` itself is reserved as a tag — don't register a custom codec with that tag.)

---

## Custom types — `TypeCodec`

```ts
interface TypeCodec<T = unknown> {
  readonly tag: string;                                  // unique, short, stable
  test(value: unknown): boolean;                          // does this codec claim `value`?
  encode(value: T, recurse: (x: unknown) => unknown): unknown;  // → JSON-safe payload
  decode(payload: unknown, recurse: (x: unknown) => unknown): T; // payload → value
}
```

- **`tag`** is written to the wire and looked up on decode — keep it unique and **stable**
  across versions (renaming it breaks already-serialized data).
- **`test`** decides which codec handles a value. Be specific (prefer `instanceof` or a
  precise `typeof`); a too-broad `test` will swallow values meant for another codec.
- **`encode`/`decode`** receive a **`recurse`** callback — call it on any inner values your
  payload contains (container elements, wrapped sub-values) so nested rich types are handled
  too. For leaf types (a class wrapping only primitives) you can ignore it.

```ts
import { createCodec, type TypeCodec } from '@ayepi/codec';

class Money { constructor(public cents: bigint, public currency: string) {} }

const moneyCodec: TypeCodec<Money> = {
  tag: 'Money',
  test: (v) => v instanceof Money,
  // `cents` is a bigint — recurse so the built-in BigInt codec encodes it.
  encode: (m, recurse) => ({ cents: recurse(m.cents), currency: m.currency }),
  decode: (p, recurse) => {
    const o = p as { cents: unknown; currency: string };
    return new Money(recurse(o.cents) as bigint, o.currency);
  },
};

const codec = createCodec({ types: [moneyCodec] });
codec.parse(codec.stringify(new Money(1099n, 'USD'))); // → Money { cents: 1099n, currency: 'USD' }
```

### Precedence

Custom `types` are checked **before** the built-ins. The **first** codec whose `test`
returns `true` wins. This lets a custom codec **override** a built-in:

```ts
import { createCodec } from '@ayepi/codec';

// Store Date as epoch millis instead of the built-in ISO string.
const codec = createCodec({
  types: [{
    tag: 'EpochDate',
    test: (v) => v instanceof Date,
    encode: (d: Date) => d.getTime(),
    decode: (ms) => new Date(ms as number),
  }],
});
codec.encode(new Date(0)); // → { $t: 'EpochDate', value: 0 }
```

Use `replaceBuiltins: true` for a codec that handles **only** your types (built-in values
then fall through to plain-object/array walking — e.g. a `Date` becomes `{}`).

---

## Gotchas

- **No circular references.** A cycle overflows the stack, exactly like `JSON.stringify`.
  Break cycles before encoding if your graph may contain them.
- **`stack` is environment-specific.** Serialized `Error.stack` strings carry file paths
  and frames from the producing process; treat them as diagnostic text, not stable data.
- **Subclass identity isn't reconstructed.** Decoded errors are base `Error` instances with
  the original `name`. For richer error types, register a custom `TypeCodec`.
- **Tag stability.** Changing a `tag` (built-in or custom) makes previously serialized data
  with the old tag decode as a plain object. Keep tags fixed for any persisted data.
- **Reserved tag.** `'$escape'` is used internally for the collision escape; don't reuse it.
- **`tagKey` must be a string** and should be consistent between the encoder and decoder of
  the same data (the default `'$t'` is fine for most uses).

---

## Recipes

**Persist to `localStorage` with full fidelity:**

```ts
import { stringify, parse } from '@ayepi/codec';
localStorage.setItem('state', stringify(state));
const state = parse(localStorage.getItem('state') ?? 'null');
```

**A project-wide codec with your domain types:**

```ts
// codec.ts
import { createCodec } from '@ayepi/codec';
import { moneyCodec } from './money.js';
import { pointCodec } from './point.js';

export const codec = createCodec({ types: [moneyCodec, pointCodec] });
export const { stringify, parse } = codec;
```

**Inspect the wire shape without producing a string:**

```ts
import { defaultCodec } from '@ayepi/codec';
console.dir(defaultCodec.encode(myValue), { depth: null });
```
