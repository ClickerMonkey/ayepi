# @ayepi/sqlite

SQLite backends for ayepi on one database file, through a
[better-sqlite3](https://github.com/WiseLibs/better-sqlite3) connection you open:

- **`sqliteQueue`**, **`sqliteStore`**, **`sqlitePubSub`** (or all three as **`sqliteBackend`**) — the
  [`@ayepi/work`](https://www.npmjs.com/package/@ayepi/work) ports: a leased, at-least-once queue with dead
  letters, a key/value store with an atomic claim and counter, and pub/sub across processes.
- **`sqliteRateStore`** — an [`@ayepi/rate`](https://www.npmjs.com/package/@ayepi/rate) store running rate's
  own algorithms (weighted costs included) on rows, shared by every process using the file.

```sh
pnpm add @ayepi/sqlite better-sqlite3 zod
```

```ts
import Database from 'better-sqlite3'
import { createWork } from '@ayepi/work'
import { sqliteBackend } from '@ayepi/sqlite'

const db = new Database('app.db')
db.pragma('journal_mode = WAL')
const work = createWork({ work: [send] as const, ...sqliteBackend(db) })
```

## For AI coding agents

This package ships a dense, machine-oriented reference written for **AI coding agents**:

- [`ayepi-sqlite.md`](./ayepi-sqlite.md)

## License

MIT
