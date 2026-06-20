# @ayepi/codec

Rich, reversible JSON. A **tagged codec** that round-trips the values plain
`JSON.stringify`/`parse` silently lose or mangle — `Date`, `BigInt`, `Map`, `Set`,
`undefined`, `Error`, `RegExp`, `URL`, and the number specials `NaN`/`±Infinity` —
plus any custom types you register. Zero dependencies.

```sh
pnpm add @ayepi/codec
```

```ts
import { stringify, parse } from '@ayepi/codec'

const s = stringify({ when: new Date(), ids: new Set([1n, 2n]), missing: undefined })
const value = parse(s)
// value.when  → Date
// value.ids   → Set<bigint>
// value.missing === undefined   (preserved, not dropped)
```

Bare `import` has **no side effects**.

## How it works

A value a codec handles is wrapped as `{ "$t": "<tag>", "value": <payload> }`.
Encoding/decoding is **recursive**, so a `Map` of `Date`s, a `Set` of objects, and
deeply nested mixes all round-trip. Ordinary JSON values (`null`, booleans, finite
numbers, strings, plain arrays/objects) pass through untouched.

If a *plain* object legitimately owns a `$t` property, it is **escaped** so it still
round-trips:

```ts
parse(stringify({ $t: 'hello' })) // → { $t: 'hello' }  ✅
```

## Custom types

Register a `TypeCodec` (a `tag`, a `test`, and `encode`/`decode`):

```ts
import { createCodec } from '@ayepi/codec'

class Point { constructor(public x: number, public y: number) {} }

const codec = createCodec({
  types: [{
    tag: 'Point',
    test: (v) => v instanceof Point,
    encode: (p: Point) => [p.x, p.y],
    decode: ([x, y]: [number, number]) => new Point(x, y),
  }],
})

codec.parse(codec.stringify(new Point(3, 4))) // → Point { x: 3, y: 4 }
```

Custom types are checked **before** the built-ins, so a custom codec can override one
(e.g. store `Date` as epoch millis). Pass `replaceBuiltins: true` to drop the built-ins
entirely, or `tagKey` to change the sentinel key from `'$t'`.

`encode`/`decode` are also exposed standalone (value ⇄ JSON-safe value, no string step).

> No circular-reference support — a cycle overflows the stack, exactly like
> `JSON.stringify`.

## License

MIT © Philip Diffenderfer
