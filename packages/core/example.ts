/* ============================================================================
 * ayepi example — exercises every feature, doubles as the type test suite.
 *
 *   npx tsc --noEmit          → verifies all the static guarantees below
 *   npx tsx src/example.ts    → runs the smoke test (HTTP + WS, in-process)
 * ==========================================================================*/
import { z } from 'zod';
import {
  middleware,
  ctx,
  endpoint,
  spec,
  path,
  implement,
  server,
  client,
  reject,
  localBroker,
  ApiError,
  type ClientData,
  type HandlerPayload,
  type CallOpts,
  type CallArgs,
  type CallReturn,
  type HandlerReturn,
  type MaybePromise,
  type CookieOptions,
  type StreamBody,
  type WsConn,
} from './src/index';

/* ============================================================================
 * 1. Middleware
 * ==========================================================================*/

interface User {
  id: string;
  name: string;
  role: 'admin' | 'member';
}

/** plain middleware **def** — provides nothing, just wraps (impl bound in coreHandlers) */
const log = middleware('log');

/** def: provides { user }; contributes its security scheme to the docs */
const auth = middleware('auth', { provides: ctx<{ user: User }>(), doc: { security: { bearerAuth: { type: 'http', scheme: 'bearer' } } } });

/** def: optional dep — runs after auth IF auth is present, but doesn't pull it in */
const cache = middleware('cache', { provides: ctx<{ cached: boolean }>(), optional: [auth] });

/** def: hard dep — auth is auto-included, ctx.user guaranteed in the impl */
const org = middleware('org', { provides: ctx<{ org: { id: string; name: string } }>(), requires: [auth] });

/** loader def — owns the :projectId path param; a stacked prefix gives it its position */
const project = middleware.loader('projectId', z.uuid(), { provides: ctx<{ project: { id: string; ownerId: string } }>(), requires: [auth] });

/* ============================================================================
 * 2. Path templates — parts-based, no string replacement anywhere
 * ==========================================================================*/

const userPath = path`/users/${{ id: z.string() }}`;
const reportPath = path`/reports/${{ year: z.coerce.number().int() }}/${{ slug: z.string() }}`;
const orgPrefix = path`/orgs/${{ orgSlug: z.string() }}`;

/* ============================================================================
 * 3. Spec
 * ==========================================================================*/

const UserOut = z.object({ id: z.string(), name: z.string(), role: z.enum(['admin', 'member']) });

export const api = spec({
  endpoints: {
    /* bare endpoint, no input, no response — defaults: POST /health */
    health: endpoint({}),

    ...auth.with(log, cache).group({
      /* params only — default path /getUser/:id, default method POST */
      getUser: {
        params: z.object({ id: z.string() }),
        response: UserOut,
      },
      /* path template provides the params; body merges with them into data (disjoint kinds) */
      updateUser: {
        method: 'PATCH',
        path: userPath,
        ws: 'user:update',
        body: z.object({ name: z.string().min(1), age: z.number().int().optional() }),
        response: UserOut,
        doc: { summary: 'Update a user', tags: ['users'] },
      },
    }),

    /* template with a coerced segment */
    getReport: endpoint({
      method: 'GET',
      path: reportPath,
      response: z.object({ year: z.number(), slug: z.string() }),
    }),

    /* disjoint kinds: query + body merge into one data payload */
    searchDocs: endpoint({
      query: z.object({ q: z.string(), limit: z.coerce.number().int().default(10) }),
      body: z.object({ filters: z.array(z.string()) }),
      response: z.object({ hits: z.number(), q: z.string() }),
    }),

    /* non-object body → it IS the data payload */
    echoText: endpoint({
      body: z.string(),
      response: z.object({ len: z.number() }),
    }),

    /* status override + set-cookie + declared typed errors */
    login: endpoint({
      body: z.object({ user: z.string() }),
      response: z.object({ ok: z.boolean() }),
      errors: { 403: z.object({ reason: z.string() }) },
      doc: { summary: 'Start a session', tags: ['auth'] },
    }),

    /* typed request headers + cookies (sent via opts.headers, parsed server-side) */
    whoami: endpoint({
      headers: z.object({ 'x-client-version': z.string() }),
      cookies: z.object({ session: z.string() }),
      response: z.object({ version: z.string(), session: z.string() }),
      doc: { summary: 'Who am I', description: 'Echoes session + client version', tags: ['auth'] },
    }),

    /* multi-status: handler picks the status, client gets a { status, data } union */
    createThing: endpoint({
      body: z.object({ name: z.string() }),
      responses: {
        200: z.object({ existing: z.string() }),
        201: z.object({ id: z.string() }),
      },
      doc: { summary: 'Create a thing (or find existing)', tags: ['things'] },
    }),

    /* HTML form post: application/x-www-form-urlencoded */
    submitForm: endpoint({
      body: z.object({ title: z.string(), count: z.coerce.number().int() }),
      bodyEncoding: 'urlencoded',
      response: z.object({ title: z.string(), count: z.number() }),
    }),

    /* multipart — files force httpOnly; file + body fields merge into data */
    uploadDoc: endpoint({
      files: { doc: z.file() },
      body: z.object({ title: z.string() }),
      response: z.object({ size: z.number(), title: z.string() }),
    }),

    /* raw streaming request body — the stream rides in opts */
    ingestData: endpoint({
      streamIn: 'application/octet-stream',
      query: z.object({ tag: z.string() }),
      response: z.object({ bytes: z.number() }),
    }),

    /* streaming response (raw, return-style) */
    exportCsv: endpoint({
      method: 'GET',
      streamOut: 'text/csv',
      query: z.object({ rows: z.coerce.number().int() }),
    }),

    /* typed item stream — async generator both ends, NDJSON over http, chunk frames over ws */
    streamRows: endpoint({
      method: 'GET',
      query: z.object({ n: z.coerce.number().int() }),
      streamOut: z.object({ i: z.number(), squared: z.number() }),
    }),

    /* SSE item stream — EventSource-compatible */
    tickerSse: endpoint({
      method: 'GET',
      query: z.object({ n: z.coerce.number().int() }),
      streamOut: z.object({ tick: z.number() }),
      streamEncoding: 'sse',
    }),

    /* typed duplex: client streams items IN (opts.stream), server streams items OUT */
    enrichEvents: endpoint({
      query: z.object({ factor: z.coerce.number() }),
      streamIn: z.object({ id: z.number(), v: z.number() }),
      streamOut: z.object({ id: z.number(), scaled: z.number() }),
    }),

    /* browser-downloadable zip: GET + raw stream + pipe style + dynamic download() */
    downloadZip: endpoint({
      method: 'GET',
      query: z.object({ name: z.string() }),
      streamOut: 'application/zip',
      download: 'bundle.zip',
    }),

    /* resumable download: length() enables Content-Length + HTTP Range */
    downloadLog: endpoint({
      method: 'GET',
      streamOut: 'text/plain',
      download: 'log.txt',
    }),

    /* explicitly http-only */
    rotateKeys: auth.endpoint({
      httpOnly: true,
      response: z.object({ rotated: z.boolean() }),
    }),

    /* stacked string prefix: position for the loader-owned :projectId; final path /projects/:projectId/tasks */
    ...org.with(project).path('/projects/:projectId').group({
      listTasks: {
        method: 'GET',
        path: '/tasks',
        query: z.object({ done: z.coerce.boolean().optional() }),
        response: z.array(z.object({ id: z.string(), title: z.string() })),
      },
    }),

    /* stacked template prefix: declares + positions :orgSlug, types merge into the endpoint */
    ...auth.path(orgPrefix).group({
      orgInfo: {
        method: 'GET',
        path: '/info',
        response: z.object({ slug: z.string(), owner: z.string() }),
      },
    }),
  },

  events: {
    jobProgress: {
      params: z.object({ jobId: z.string() }),
      data: z.object({ pct: z.number() }),
      doc: { summary: 'Per-job progress updates' },
    },
    roomMessage: {
      params: z.object({ roomId: z.string() }),
      data: z.object({ from: z.string(), text: z.string() }),
      guard: [auth],
    },
    systemNotice: {
      data: z.object({ msg: z.string() }),
      ws: 'sys:notice',
    },
  },

  /* spec-level final patches over the generated documents */
  doc: {
    openapi: (d) => ({ ...d, servers: [{ url: 'https://api.example.dev' }] }),
    asyncapi: (d) => ({ ...d, defaultContentType: 'application/json' }),
  },
});

type Api = typeof api;

/* ============================================================================
 * 4. Compile-time type tests
 * ==========================================================================*/

type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type Eps = Api['endpoints'];

/* --- path templates: typed build/parse, schemas must accept string input --- */
type _p1 = Expect<Equal<Parameters<typeof userPath.build>[0], { id: string }>>;
type _p2 = Expect<Equal<ReturnType<typeof reportPath.parse>, { year: number; slug: string } | null>>;

/* --- health: no data at all → call(name, opts?) --- */
type _t1 = Expect<Equal<ClientData<Eps['health']>, {}>>;
type _t2 = Expect<Equal<CallArgs<Eps['health']>, [opts?: CallOpts<Eps['health']>]>>;

/* --- getUser: params are the data --- */
type _t3 = Expect<Equal<ClientData<Eps['getUser']>, { id: string }>>;

/* --- updateUser: template params + body merge into one payload --- */
type _t4 = Expect<Equal<ClientData<Eps['updateUser']>, { id: string; name: string; age?: number }>>;

/* --- getReport: coerced template segment → unknown input, number output --- */
type _t5 = Expect<Equal<ClientData<Eps['getReport']>, { year: unknown; slug: string }>>;

/* --- searchDocs: query + body, disjoint, one object --- */
type _t6 = Expect<Equal<ClientData<Eps['searchDocs']>, { q: string; limit?: unknown; filters: string[] }>>;

/* --- echoText: non-object body IS the data, positionally required --- */
type _t7 = Expect<Equal<ClientData<Eps['echoText']>, string>>;
type _t8 = Expect<Equal<CallArgs<Eps['echoText']>, [data: string, opts?: CallOpts<Eps['echoText']>]>>;

/* --- uploadDoc: files merge into data --- */
type _t9 = Expect<Equal<ClientData<Eps['uploadDoc']>, { doc: File; title: string }>>;

/* --- ingestData: opts required (carries the stream) --- */
type _t10 = Expect<Equal<CallArgs<Eps['ingestData']>, [data: { tag: string }, opts: CallOpts<Eps['ingestData']>]>>;
type _t11 = Expect<Equal<CallOpts<Eps['ingestData']>['stream'], StreamBody>>;

/* --- stacked prefixes: loader param via string prefix; template prefix types merge in --- */
type _t12 = Expect<Equal<ClientData<Eps['listTasks']>, { projectId: string; done?: unknown }>>;
type _t13 = Expect<Equal<ClientData<Eps['orgInfo']>, { orgSlug: string }>>;

/* --- transport narrowing: raw streams/files ban 'ws'; item streams allow it --- */
type _t14 = Expect<Equal<CallOpts<Eps['rotateKeys']>['transport'], 'http' | undefined>>;
type _t15 = Expect<Equal<CallOpts<Eps['uploadDoc']>['transport'], 'http' | undefined>>;
type _t16 = Expect<Equal<CallOpts<Eps['getUser']>['transport'], 'http' | 'ws' | undefined>>;
type _t17 = Expect<Equal<CallOpts<Eps['enrichEvents']>['transport'], 'http' | 'ws' | undefined>>;
type _t18 = Expect<Equal<CallOpts<Eps['streamRows']>['transport'], 'http' | 'ws' | undefined>>;

/* --- handler payloads: ctx at root, ONE merged data, no kind objects --- */
type GetUserP = HandlerPayload<Api, Eps['getUser']>;
type _t19 = Expect<Equal<GetUserP['data'], { id: string }>>;
type _t20 = Expect<Equal<GetUserP['user'], User>>;
type _t21 = Expect<Equal<GetUserP['cached'], boolean>>;
type _t22 = Expect<'params' extends keyof GetUserP ? false : true>;
type _t23 = Expect<'query' extends keyof GetUserP ? false : true>;
type _t24 = Expect<'body' extends keyof GetUserP ? false : true>;

type SearchP = HandlerPayload<Api, Eps['searchDocs']>;
type _t25 = Expect<Equal<SearchP['data'], { q: string; limit: number; filters: string[] }>>;

type EchoP = HandlerPayload<Api, Eps['echoText']>;
type _t26 = Expect<Equal<EchoP['data'], string>>;

type IngestP = HandlerPayload<Api, Eps['ingestData']>;
type _t27 = Expect<Equal<IngestP['stream'], ReadableStream<Uint8Array>>>;
type _t28 = Expect<Equal<IngestP['data'], { tag: string }>>;

type TasksP = HandlerPayload<Api, Eps['listTasks']>;
type _t29 = Expect<Equal<TasksP['data'], { projectId: string; done?: boolean | undefined }>>;
type _t30 = Expect<Equal<TasksP['project'], { id: string; ownerId: string }>>;
type _t31 = Expect<Equal<TasksP['org'], { id: string; name: string }>>;

type OrgInfoP = HandlerPayload<Api, Eps['orgInfo']>;
type _t32 = Expect<Equal<OrgInfoP['data'], { orgSlug: string }>>;
type _t33 = Expect<Equal<OrgInfoP['user'], User>>;

/* every handler gets the framework context */
type _t34 = Expect<Equal<GetUserP['req'], Request>>;
type _t35 = Expect<Equal<GetUserP['signal'], AbortSignal>>;
type _t36 = Expect<Equal<GetUserP['status'], (code: number) => void>>;
type _t37 = Expect<Equal<GetUserP['cookie'], (name: string, value: string, opts?: CookieOptions) => void>>;

/* --- typed item streams: AsyncIterable on both ends --- */
type Row = { i: number; squared: number };
type _t38 = Expect<Equal<CallReturn<Eps['streamRows']>, AsyncIterable<Row>>>;
type _t39 = Expect<Equal<HandlerReturn<Eps['streamRows']>, MaybePromise<AsyncIterable<Row>>>>;

/* --- raw stream download --- */
type _t40 = Expect<Equal<CallReturn<Eps['downloadZip']>, Promise<ReadableStream<Uint8Array>>>>;
type ZipP = HandlerPayload<Api, Eps['downloadZip']>;
type _t41 = Expect<Equal<ZipP['out'], WritableStream<Uint8Array | string>>>;
type _t42 = Expect<Equal<ZipP['download'], (filename: string, contentType?: string) => void>>;
type _t43 = Expect<'out' extends keyof GetUserP ? false : true>;
type _t44 = Expect<'out' extends keyof HandlerPayload<Api, Eps['streamRows']> ? false : true>;
type _t45 = Expect<
  Equal<HandlerReturn<Eps['downloadZip']>, MaybePromise<ReadableStream<Uint8Array> | AsyncIterable<string | Uint8Array> | void>>
>;

/* --- typed duplex: stream rides in opts, typed AsyncIterable on the handler --- */
type EvIn = { id: number; v: number };
type _t46 = Expect<Equal<CallOpts<Eps['enrichEvents']>['stream'], AsyncIterable<EvIn> | (() => AsyncIterable<EvIn>)>>;
type EnrichP = HandlerPayload<Api, Eps['enrichEvents']>;
type _t47 = Expect<Equal<EnrichP['stream'], AsyncIterable<EvIn>>>;
type _t48 = Expect<Equal<CallReturn<Eps['enrichEvents']>, AsyncIterable<{ id: number; scaled: number }>>>;

/* --- headers / cookies kinds (still root payload props on the handler) --- */
type WhoamiP = HandlerPayload<Api, Eps['whoami']>;
type _t49 = Expect<Equal<WhoamiP['headers'], { 'x-client-version': string }>>;
type _t50 = Expect<Equal<WhoamiP['cookies'], { session: string }>>;

/* --- declared errors: fail typed and gated --- */
type LoginP = HandlerPayload<Api, Eps['login']>;
type _t51 = Expect<Equal<LoginP['fail'] extends (...a: never[]) => never ? true : false, true>>;
type _t52 = Expect<'fail' extends keyof GetUserP ? false : true>;

/* --- multi-status: discriminated unions both directions --- */
type ThingRet = Awaited<CallReturn<Eps['createThing']>>;
type _t53 = Expect<Equal<ThingRet, { status: 200; data: { existing: string } } | { status: 201; data: { id: string } }>>;
type ThingHandlerRet = Awaited<HandlerReturn<Eps['createThing']>>;
type _t54 = Expect<
  Equal<ThingHandlerRet, { readonly status: 200; readonly data: { existing: string } } | { readonly status: 201; readonly data: { id: string } }>
>;

/* ============================================================================
 * 5. Negative cases — these MUST be type errors
 * ==========================================================================*/

declare const _sdk: ReturnType<typeof client<Api>>;

function _negatives() {
  // @ts-expect-error — wrong param type
  void _sdk.call('getUser', { id: 123 });

  // @ts-expect-error — unknown key in data
  void _sdk.call('getUser', { id: 'u1', nope: true });

  // @ts-expect-error — required keys missing from data
  void _sdk.call('searchDocs', { filters: [] });

  // @ts-expect-error — non-object body endpoint takes the raw value, not an object
  void _sdk.call('echoText', { text: 'hi' });

  // @ts-expect-error — data is required for echoText
  void _sdk.call('echoText');

  // @ts-expect-error — ws transport banned on httpOnly endpoint
  void _sdk.call('rotateKeys', { transport: 'ws' });

  // @ts-expect-error — ws transport banned on files endpoint (forced httpOnly)
  void _sdk.call('uploadDoc', { doc: new File([], 'x'), title: 't' }, { transport: 'ws' });

  // @ts-expect-error — opts (with stream) is required on streamIn endpoints
  void _sdk.call('ingestData', { tag: 'x' });

  // @ts-expect-error — opts.stream is required on streamIn endpoints
  void _sdk.call('ingestData', { tag: 'x' }, {});

  // @ts-expect-error — event params required for parameterized channels
  _sdk.on('jobProgress', (d) => void d);

  // @ts-expect-error — url() only accepts GET endpoints (updateUser is PATCH)
  void _sdk.url('updateUser', { id: 'x', name: 'y' });

  // @ts-expect-error — url() data still fully typed
  void _sdk.url('downloadZip', { name: 123 });

  void _sdk.call(
    'enrichEvents',
    { factor: 2 },
    {
      // @ts-expect-error — stream items must match the declared input shape
      stream: async function* () {
        yield { id: 'nope', v: 1 };
      },
    },
  );

  void endpoint({
    params: z.object({ id: z.string() }),
    // @ts-expect-error — custom path references undeclared param keys
    path: '/things/:thingId',
  });

  void endpoint({
    params: z.object({ id: z.string() }),
    // @ts-expect-error — query keys must be disjoint from path params
    query: z.object({ id: z.string() }),
  });

  void endpoint({
    query: z.object({ q: z.string() }),
    // @ts-expect-error — body keys must be disjoint from path/query
    body: z.object({ q: z.string(), filters: z.array(z.string()) }),
  });

  void endpoint({
    query: z.object({ tag: z.string() }),
    // @ts-expect-error — a non-object body excludes params/query/files
    body: z.string(),
  });

  void endpoint({
    params: z.object({ id: z.string() }),
    // @ts-expect-error — template path must not re-declare param keys
    path: userPath,
  });

  // @ts-expect-error — stacked prefix must not re-declare loader-owned keys
  void org.with(project).path(path`/projects/${{ projectId: z.uuid() }}`);

  // @ts-expect-error — path template schemas must accept string input (z.number() does not)
  void path`/x/${{ n: z.number() }}`;

  void implement(api).handlers({
    // @ts-expect-error — item stream handler must yield the declared item shape
    streamRows: async function* ({ data }) {
      yield { i: String(data.n) };
    },
  });

  void implement(api).handlers({
    login: ({ fail }) => {
      // @ts-expect-error — 500 is not a declared error status for login
      fail(500, { reason: 'x' });
      return { ok: true };
    },
  });

  void implement(api).handlers({
    login: ({ fail }) => {
      // @ts-expect-error — fail data must match the declared 403 schema
      fail(403, { nope: true });
      return { ok: true };
    },
  });

  void implement(api).handlers({
    // @ts-expect-error — 418 is not a declared response status for createThing
    createThing: () => ({ status: 418, data: { id: 'x' } }) as const,
  });

  void implement(api).handlers({
    // @ts-expect-error — download only exists on raw streamOut endpoints
    getUser: ({ data, download }) => {
      void download;
      return { id: data.id, name: 'x', role: 'admin' as const };
    },
  });
}
void _negatives;

/* ============================================================================
 * 6. Implementation
 * ==========================================================================*/

/* ---- minimal stored (no-compression) zip writer, streamed entry by entry ---- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;}
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);}
  return (c ^ 0xffffffff) >>> 0;
}
function le(bytes: number, v: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) {out[i] = (v >>> (8 * i)) & 0xff;}
  return out;
}
function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}
async function* zipStream(entries: ReadonlyArray<{ name: string; data: string }>): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameB = enc.encode(entry.name);
    const dataB = enc.encode(entry.data);
    const crc = crc32(dataB);
    const local = cat(le(4, 0x04034b50), le(2, 20), le(2, 0), le(2, 0), le(2, 0), le(2, 0), le(4, crc), le(4, dataB.length), le(4, dataB.length), le(2, nameB.length), le(2, 0), nameB, dataB);
    central.push(
      cat(le(4, 0x02014b50), le(2, 20), le(2, 20), le(2, 0), le(2, 0), le(2, 0), le(2, 0), le(4, crc), le(4, dataB.length), le(4, dataB.length), le(2, nameB.length), le(2, 0), le(2, 0), le(2, 0), le(2, 0), le(4, 0), le(4, offset), nameB),
    );
    offset += local.length;
    yield local;
  }
  const cd = cat(...central);
  yield cd;
  yield cat(le(4, 0x06054b50), le(2, 0), le(2, 0), le(2, entries.length), le(2, entries.length), le(4, cd.length), le(4, offset), le(2, 0));
}

/** Bind every middleware impl on the core builder; `server()` merges both builders' bindings. */
export const coreHandlers = implement(api)
  .middleware(log, async (io) => {
    const t = Date.now();
    const r = await io.next({});
    console.log(`  [log] ${io.req.method} ${new URL(io.req.url).pathname} ${Date.now() - t}ms`);
    return r;
  })
  .middleware(auth, async (io) => {
    const h = io.req.headers.get('authorization');
    if (h !== 'Bearer secret') {throw reject(401, 'UNAUTHORIZED');}
    const user: User = { id: 'u1', name: 'Phil', role: 'admin' };
    return io.next({ user });
  })
  .middleware(cache, async (io) => {
    const who: User | undefined = io.ctx.user;
    void who;
    return io.next({ cached: false as boolean });
  })
  .middleware(org, async (io) => {
    const owner: User = io.ctx.user;
    return io.next({ org: { id: 'org1', name: `${owner.name}'s org` } });
  })
  .middleware(project, async (io) => {
    const user: User = io.ctx.user;
    return io.next({ project: { id: io.value, ownerId: user.id } });
  })
  .handlers({
  health: () => {},

  getUser: ({ data, user, cached }) => {
    void cached;
    return { id: data.id, name: user.name, role: user.role };
  },

  updateUser: ({ data, user, emit }) => {
    emit('jobProgress', { jobId: 'job-1' }, { pct: 100 });
    return { id: data.id, name: data.name, role: user.role };
  },

  getReport: ({ data }) => ({ year: data.year, slug: data.slug }),

  /* one merged payload — q came from the query string, filters from the JSON body */
  searchDocs: ({ data }) => ({ hits: data.filters.length, q: data.q }),

  /* raw body: data IS the string */
  echoText: ({ data }) => ({ len: data.length }),

  /* status override + set-cookie + typed declared error */
  login: ({ data, fail, status, cookie }) => {
    if (data.user === 'blocked') {fail(403, { reason: 'account blocked' });}
    status(201);
    cookie('session', `sess-${data.user}`, { httpOnly: true, path: '/', sameSite: 'Lax' });
    return { ok: true };
  },

  /* typed headers + cookies in */
  whoami: ({ headers, cookies }) => ({ version: headers['x-client-version'], session: cookies.session }),

  /* multi-status: return { status, data }, each typed against its schema */
  createThing: ({ data }) => {
    if (data.name === 'existing') {return { status: 200, data: { existing: data.name } } as const;}
    return { status: 201, data: { id: `thing-${data.name}` } } as const;
  },

  submitForm: ({ data }) => ({ title: data.title, count: data.count }),
});

export const restHandlers = implement(api).handlers({
  uploadDoc: ({ data }) => ({ size: data.doc.size, title: data.title }),

  ingestData: async ({ stream, data }) => {
    void data.tag;
    let bytes = 0;
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {break;}
      bytes += value.byteLength;
    }
    return { bytes };
  },

  exportCsv: ({ data }) =>
    (async function* () {
      yield 'id,name\n';
      for (let i = 0; i < data.rows; i++) {yield `${i},row${i}\n`;}
    })(),

  streamRows: async function* ({ data }) {
    for (let i = 0; i < data.n; i++) {yield { i, squared: i * i };}
  },

  tickerSse: async function* ({ data }) {
    for (let i = 0; i < data.n; i++) {yield { tick: i };}
  },

  /* duplex: for-await the typed input stream, yield the typed output stream */
  enrichEvents: async function* ({ stream, data }) {
    for await (const item of stream) {yield { id: item.id, scaled: item.v * data.factor };}
  },

  /* pipe style: nothing returned — stream into out, name the file per-request */
  downloadZip: async ({ data, out, download }) => {
    download(`${data.name}.zip`);
    const rs = new ReadableStream<Uint8Array>({
      async start(c) {
        for await (const chunk of zipStream([{ name: `${data.name}.txt`, data: `hello from ${data.name}\n` }])) {c.enqueue(chunk);}
        c.close();
      },
    });
    await rs.pipeTo(out);
  },

  /* length() declares the total → Content-Length on full GETs, 206 + Content-Range on Range requests */
  downloadLog: async ({ out, length }) => {
    const text = '0123456789'.repeat(10); // 100 bytes
    length(text.length);
    const rs = new ReadableStream<string>({
      start(c) {
        c.enqueue(text);
        c.close();
      },
    });
    await rs.pipeTo(out);
  },

  rotateKeys: ({ user }) => ({ rotated: user.role === 'admin' }),

  listTasks: ({ project, org, data }) => {
    void data.done;
    return [{ id: 't1', title: `task for ${data.projectId} in ${org.name} (loader: ${project.id})` }];
  },

  orgInfo: ({ data, user }) => ({ slug: data.orgSlug, owner: user.name }),
});

/* one broker shared across instances = multi-pod fanout (smoke-tested below) */
const broker = localBroker();

export const app = server(api, [coreHandlers, restHandlers], {
  cors: { origin: ['https://app.example.dev'], credentials: true, maxAge: 600 },
  broker,
});

function _missingHandlerNegative() {
  // @ts-expect-error — missing handlers are a compile error naming the endpoints
  void server(api, [coreHandlers]);

  void implement(api).handlers({
    // @ts-expect-error — wrong return shape for getUser
    getUser: () => ({ id: 'x' }),
  });
}
void _missingHandlerNegative;

/* ============================================================================
 * 7. Smoke test — npx tsx src/example.ts
 * ==========================================================================*/

async function main() {
  const manifest = app.manifest();
  const AUTH = { authorization: 'Bearer secret' };

  /* ---- in-process ws wiring ---- */
  let clientOnMessage: (frame: string) => void = () => {};
  const conn: WsConn = app.ws.open((frame) => clientOnMessage(frame), new Request('http://test/ws', { headers: AUTH }));

  const sdk = client<Api>({
    baseUrl: 'http://test',
    manifest,
    headers: AUTH,
    fetchImpl: (req) => app.fetch(req),
    ws: {
      send: (frame) => void app.ws.message(conn, frame),
      onMessage: (cb) => {
        clientOnMessage = cb;
      },
    },
  });

  const ok = (label: string, cond: boolean) => {
    if (!cond) {throw new Error(`FAIL: ${label}`);}
    console.log(`✓ ${label}`);
  };

  /* path templates standalone */
  ok('path template pattern', userPath.pattern === '/users/:id' && reportPath.pattern === '/reports/:year/:slug');
  ok('path template parts', reportPath.parts.length === 3 && reportPath.parts[0]!.t === 'lit' && reportPath.parts[1]!.t === 'param');
  ok('path template build', reportPath.build({ year: 2026, slug: 'q2' }) === '/reports/2026/q2');
  const parsed = reportPath.parse('/reports/2026/q2');
  ok('path template parse', parsed !== null && parsed.year === 2026 && parsed.slug === 'q2');
  ok('path template no-match', reportPath.parse('/nope') === null);
  ok('segment encoding round-trip', userPath.parse(userPath.build({ id: 'a/b c' })) ?. id === 'a/b c');

  /* stacked prefixes land in the manifest paths */
  ok('string prefix stacking', manifest.endpoints.listTasks!.path === '/projects/:projectId/tasks');
  ok('template prefix stacking', manifest.endpoints.orgInfo!.path === '/orgs/:orgSlug/info');

  /* http calls — one positional data payload */
  await sdk.call('health');
  ok('health (no data)', true);

  const u = await sdk.call('getUser', { id: 'u1' });
  ok('getUser data → path', u.name === 'Phil' && u.role === 'admin');

  const u2 = await sdk.call('updateUser', { id: 'u9', name: 'New Name' });
  ok('updateUser via path template', u2.id === 'u9' && u2.name === 'New Name');

  const rep = await sdk.call('getReport', { year: 2026, slug: 'q2' });
  ok('template coerced segment', rep.year === 2026 && rep.slug === 'q2');

  const s1 = await sdk.call('searchDocs', { q: 'x', filters: ['a', 'b'] });
  ok('searchDocs merged query+body', s1.hits === 2 && s1.q === 'x');

  const e1 = await sdk.call('echoText', 'hello');
  ok('echoText raw body as data', e1.len === 5);

  const up = await sdk.call('uploadDoc', { doc: new File(['abcdef'], 'd.txt'), title: 'Doc' });
  ok('uploadDoc multipart', up.size === 6 && up.title === 'Doc');

  const ing = await sdk.call('ingestData', { tag: 't' }, { stream: 'streaming-bytes!' });
  ok('ingestData stream via opts', ing.bytes === 16);

  const csvStream = await sdk.call('exportCsv', { rows: 3 });
  const csv = await new Response(csvStream).text();
  ok('exportCsv streamOut', csv.split('\n').length === 5 && csv.startsWith('id,name'));

  const rot = await sdk.call('rotateKeys');
  ok('rotateKeys httpOnly', rot.rotated);

  const projectId = '7f1e9f6a-2b1c-4e8d-9a3b-5c6d7e8f9a0b';
  const tasks = await sdk.call('listTasks', { projectId });
  ok('listTasks stacked loader chain', tasks[0]!.title.includes(projectId) && tasks[0]!.title.includes("Phil's org"));

  const oi = await sdk.call('orgInfo', { orgSlug: 'acme' });
  ok('orgInfo template-prefix param in data', oi.slug === 'acme' && oi.owner === 'Phil');

  /* multi-status */
  const created = await sdk.call('createThing', { name: 'rocket' });
  ok('multi-status 201 branch', created.status === 201 && created.data.id === 'thing-rocket');
  const existing = await sdk.call('createThing', { name: 'existing' });
  ok('multi-status 200 branch', existing.status === 200 && existing.data.existing === 'existing');
  const createdRaw = await app.fetch(
    new Request('http://test/createThing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }) }),
  );
  ok('multi-status wire status', createdRaw.status === 201);

  /* urlencoded */
  const form = await sdk.call('submitForm', { title: 'hi', count: 3 });
  ok('urlencoded body roundtrip', form.title === 'hi' && form.count === 3);
  const rawForm = await app.fetch(
    new Request('http://test/submitForm', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'title=plain+html+form&count=7',
    }),
  );
  ok('urlencoded raw HTML form', ((await rawForm.json()) as { count: number }).count === 7);

  /* typed item streams */
  const rows: number[] = [];
  for await (const row of sdk.call('streamRows', { n: 4 })) {rows.push(row.squared);}
  ok('typed item stream (NDJSON)', rows.join(',') === '0,1,4,9');

  const ticks: number[] = [];
  for await (const t of sdk.call('tickerSse', { n: 3 })) {ticks.push(t.tick);}
  ok('SSE item stream decode', ticks.join(',') === '0,1,2');
  const sseRaw = await app.fetch(new Request('http://test/tickerSse?n=1'));
  ok('SSE content-type + framing', sseRaw.headers.get('content-type') === 'text/event-stream' && (await sseRaw.text()) === 'data: {"tick":0}\n\n');

  /* typed duplex: stream in opts, for-await out (http) */
  const scaled: number[] = [];
  for await (const r of sdk.call(
    'enrichEvents',
    { factor: 10 },
    {
      stream: async function* () {
        yield { id: 1, v: 1 };
        yield { id: 2, v: 2 };
        yield { id: 3, v: 3 };
      },
    },
  ))
    {scaled.push(r.scaled);}
  ok('typed duplex stream (opts.stream → gen out)', scaled.join(',') === '10,20,30');

  /* typed item streams over ws: chunk frames */
  const wsScaled: number[] = [];
  for await (const r of sdk.call(
    'enrichEvents',
    { factor: 5 },
    {
      stream: async function* () {
        yield { id: 1, v: 2 };
        yield { id: 2, v: 4 };
      },
      transport: 'ws',
    },
  ))
    {wsScaled.push(r.scaled);}
  ok('typed duplex over ws (chunk frames)', wsScaled.join(',') === '10,20');

  const wsRows: number[] = [];
  for await (const r of sdk.call('streamRows', { n: 3 }, { transport: 'ws' })) {wsRows.push(r.squared);}
  ok('item stream out over ws', wsRows.join(',') === '0,1,4');

  /* zip download: url() for the browser, dynamic download(), bytes via fetch */
  const zipUrl = sdk.url('downloadZip', { name: 'report' });
  ok('url() builds GET url', zipUrl === 'http://test/downloadZip?name=report');
  const zres = await app.fetch(new Request(zipUrl));
  ok('zip dynamic download filename', zres.headers.get('content-disposition') === 'attachment; filename="report.zip"');
  ok('zip content-type', zres.headers.get('content-type') === 'application/zip');
  const zbytes = new Uint8Array(await zres.arrayBuffer());
  const eocd = [0x50, 0x4b, 0x05, 0x06].every((b, i) => zbytes[zbytes.length - 22 + i] === b);
  ok('zip magic + EOCD', zbytes[0] === 0x50 && zbytes[1] === 0x4b && zbytes[2] === 0x03 && eocd);
  const zbad = await app.fetch(new Request('http://test/downloadZip'));
  ok('stream error pre-write → 400', zbad.status === 400);
  const zs = await sdk.call('downloadZip', { name: 'x' });
  const zb2 = new Uint8Array(await new Response(zs).arrayBuffer());
  ok('zip via call() stream', zb2[0] === 0x50 && [0x50, 0x4b, 0x05, 0x06].every((b, i) => zb2[zb2.length - 22 + i] === b));

  /* Range + Content-Length + HEAD (resumable downloads) */
  const full = await app.fetch(new Request('http://test/downloadLog'));
  ok('length() → content-length', full.headers.get('content-length') === '100' && (await full.text()).length === 100);
  const part = await app.fetch(new Request('http://test/downloadLog', { headers: { range: 'bytes=90-' } }));
  ok('Range → 206 + content-range', part.status === 206 && part.headers.get('content-range') === 'bytes 90-99/100' && (await part.text()) === '0123456789');
  const mid = await app.fetch(new Request('http://test/downloadLog', { headers: { range: 'bytes=10-19' } }));
  ok('Range mid-slice', (await mid.text()) === '0123456789' && mid.headers.get('content-length') === '10');
  const oob = await app.fetch(new Request('http://test/downloadLog', { headers: { range: 'bytes=500-' } }));
  ok('Range out of bounds → 416', oob.status === 416 && oob.headers.get('content-range') === 'bytes */100');
  const head = await app.fetch(new Request('http://test/downloadLog', { method: 'HEAD' }));
  ok('HEAD strips body, keeps headers', head.status === 200 && (await head.text()) === '' && head.headers.get('content-disposition') === 'attachment; filename="log.txt"');

  /* CORS */
  const pre = await app.fetch(
    new Request('http://test/createThing', {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example.dev', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    }),
  );
  ok('CORS preflight', pre.status === 204 && pre.headers.get('access-control-allow-origin') === 'https://app.example.dev' && pre.headers.get('access-control-allow-credentials') === 'true');
  const corsRes = await app.fetch(new Request('http://test/health', { method: 'POST', headers: { origin: 'https://app.example.dev' } }));
  ok('CORS on responses', corsRes.headers.get('access-control-allow-origin') === 'https://app.example.dev');
  const corsDeny = await app.fetch(new Request('http://test/health', { method: 'POST', headers: { origin: 'https://evil.dev' } }));
  ok('CORS origin denied', corsDeny.headers.get('access-control-allow-origin') === null);

  /* opt-in client-side validation */
  const vsdk = client<Api>({
    baseUrl: 'http://test',
    manifest,
    headers: AUTH,
    fetchImpl: (req) => app.fetch(req),
    validate: api,
  });
  const vu = await vsdk.call('getUser', { id: 'u1' });
  ok('client validate: response parsed', vu.name === 'Phil');
  const vRows: number[] = [];
  for await (const r of vsdk.call('streamRows', { n: 2 })) {vRows.push(r.squared);}
  ok('client validate: items parsed', vRows.join(',') === '0,1');

  /* status override + set-cookie + declared errors */
  const loginRes = await app.fetch(
    new Request('http://test/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'phil' }) }),
  );
  ok('status(201)', loginRes.status === 201);
  ok('cookie()', loginRes.headers.get('set-cookie') === 'session=sess-phil; Path=/; HttpOnly; SameSite=Lax');
  ok('login body intact', ((await loginRes.json()) as { ok: boolean }).ok === true);

  await sdk.call('login', { user: 'blocked' }).then(
    () => ok('fail typed error', false),
    (err: unknown) =>
      ok('fail typed error roundtrip', err instanceof ApiError && err.status === 403 && (err.data as { reason: string }).reason === 'account blocked'),
  );

  /* typed headers + cookies ride in opts.headers */
  const who = await sdk.call('whoami', { headers: { 'x-client-version': '1.2.3', cookie: 'session=abc123' } });
  ok('typed headers + cookies', who.version === '1.2.3' && who.session === 'abc123');
  const whoBad = await app.fetch(new Request('http://test/whoami', { method: 'POST', headers: { cookie: 'session=x' } }));
  ok('missing required header → 400', whoBad.status === 400);

  /* documentation */
  const doc = app.openapi({ title: 'Example', version: '1.0.0' }) as {
    components: { securitySchemes: Record<string, unknown> };
    servers: Array<{ url: string }>;
    paths: Record<string, Record<string, { summary?: string; security?: unknown[]; responses: Record<string, unknown>; parameters: Array<{ in: string; name: string; schema?: { type?: string } }> }>>;
  };
  ok('mw doc.security → securitySchemes', 'bearerAuth' in doc.components.securitySchemes);
  ok('mw doc.security → op security', Array.isArray(doc.paths['/users/{id}']!.patch!.security));
  ok('endpoint doc.summary', doc.paths['/users/{id}']!.patch!.summary === 'Update a user');
  ok('declared errors documented', '403' in doc.paths['/login']!.post!.responses);
  ok('multi-status documented', '200' in doc.paths['/createThing']!.post!.responses && '201' in doc.paths['/createThing']!.post!.responses);
  ok('header params documented', doc.paths['/whoami']!.post!.parameters.some((p) => p.in === 'header' && p.name === 'x-client-version'));
  ok('cookie params documented', doc.paths['/whoami']!.post!.parameters.some((p) => p.in === 'cookie' && p.name === 'session'));
  ok('template params documented', doc.paths['/reports/{year}/{slug}']!.get!.parameters.some((p) => p.in === 'path' && p.name === 'year'));
  ok('stacked path documented', '/projects/{projectId}/tasks' in doc.paths && doc.paths['/projects/{projectId}/tasks']!.get!.parameters.some((p) => p.in === 'path' && p.name === 'projectId'));
  ok('spec doc.openapi patch', doc.servers[0]!.url === 'https://api.example.dev');

  const adoc = app.asyncapi() as { defaultContentType: string; channels: Record<string, { summary?: string }> };
  ok('event doc.summary', adoc.channels.jobProgress!.summary === 'Per-job progress updates');
  ok('endpoint ws channel at url pattern', '/getUser/:id' in adoc.channels && 'user:update' in adoc.channels);
  ok('spec doc.asyncapi patch', adoc.defaultContentType === 'application/json');

  /* error shapes */
  await sdk.call('getUser', { id: 'u1' }, { headers: { authorization: 'Bearer wrong' } }).then(
    () => ok('401 propagates', false),
    (err: unknown) => ok('401 propagates', err instanceof Error && err.message.includes('UNAUTHORIZED')),
  );
  const badRes = await app.fetch(
    new Request('http://test/users/u1', { method: 'PATCH', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ name: '' }) }),
  );
  ok('400 zod validation', badRes.status === 400);

  /* ws transport — frame type = un-injected url pattern + method */
  const uw = await sdk.call('getUser', { id: 'u1' }, { transport: 'ws' });
  ok('getUser over ws', uw.name === 'Phil');

  /* raw wire-format checks: speak the protocol by hand */
  const rawReply = await new Promise<Record<string, unknown>>((resolve) => {
    const prev = clientOnMessage;
    clientOnMessage = (raw) => {
      const f = JSON.parse(raw) as Record<string, unknown>;
      if (f.id === 'wire1') {
        clientOnMessage = prev;
        resolve(f);
      } else {prev(raw);}
    };
    app.ws.message(conn, JSON.stringify({ id: 'wire1', type: '/getUser/:id', method: 'POST', data: { id: 'u1' } }));
  });
  ok('raw frame: pattern+method routing', (rawReply.data as { name: string }).name === 'Phil');
  ok('raw frame: reply is { id, data }', rawReply.id === 'wire1' && 'data' in rawReply && !('t' in rawReply));

  const rawReply2 = await new Promise<Record<string, unknown>>((resolve) => {
    const prev = clientOnMessage;
    clientOnMessage = (raw) => {
      const f = JSON.parse(raw) as Record<string, unknown>;
      if (f.id === 'wire2') {
        clientOnMessage = prev;
        resolve(f);
      } else {prev(raw);}
    };
    app.ws.message(conn, JSON.stringify({ id: 'wire2', type: 'user:update', data: { id: 'u7', name: 'Wired' } }));
  });
  ok('raw frame: explicit ws id routing (no method)', (rawReply2.data as { id: string }).id === 'u7');

  /* events: subscribe → emit → callback */
  const got: number[] = [];
  const unsub = sdk.on('jobProgress', { jobId: 'job-7' }, (d) => got.push(d.pct));
  await new Promise((r) => setTimeout(r, 10));
  app.emit('jobProgress', { jobId: 'job-7' }, { pct: 42 });
  app.emit('jobProgress', { jobId: 'OTHER' }, { pct: 99 });
  await new Promise((r) => setTimeout(r, 10));
  ok('event param-matched delivery', got.length === 1 && got[0] === 42);
  unsub();

  const notices: string[] = [];
  sdk.on('systemNotice', (d) => notices.push(d.msg));
  await new Promise((r) => setTimeout(r, 10));
  app.emit('systemNotice', { msg: 'hi' });
  await new Promise((r) => setTimeout(r, 10));
  ok('broadcast event (custom ws id)', notices[0] === 'hi');

  /* emit from inside a handler */
  const fromHandler: number[] = [];
  sdk.on('jobProgress', { jobId: 'job-1' }, (d) => fromHandler.push(d.pct));
  await new Promise((r) => setTimeout(r, 10));
  await sdk.call('updateUser', { id: 'u1', name: 'X' });
  await new Promise((r) => setTimeout(r, 10));
  ok('emit from handler', fromHandler[0] === 100);

  /* multi-instance: a second server on the same broker — emit there, hear it here */
  const app2 = server(api, [coreHandlers, restHandlers], { broker });
  const crossPod: number[] = [];
  sdk.on('jobProgress', { jobId: 'job-x' }, (d) => crossPod.push(d.pct));
  await new Promise((r) => setTimeout(r, 10));
  app2.emit('jobProgress', { jobId: 'job-x' }, { pct: 77 });
  await new Promise((r) => setTimeout(r, 10));
  ok('broker: cross-instance emit delivery', crossPod[0] === 77);

  /* runtime guards: data key routing + definition-time validations */
  await sdk.call('getUser', { id: 'u1', huh: 1 } as never).then(
    () => ok('unknown data key rejected', false),
    (err: unknown) => ok('unknown data key rejected', err instanceof Error && err.message.includes('does not belong')),
  );
  let threw = false;
  try {
    spec({ endpoints: { bad: endpoint({ params: z.object({ id: z.string() }), query: z.object({ id: z.string() }) } as never) } });
  } catch {
    threw = true;
  }
  ok('spec() rejects kind collisions at definition time', threw);
  threw = false;
  try {
    spec({ endpoints: { bad: org.with(project).path(path`/projects/${{ projectId: z.uuid() }}` as never).group({ x: {} }).x } });
  } catch {
    threw = true;
  }
  ok('spec() rejects duplicate stacked params', threw);

  /* zod-free manifest */
  ok('app.manifest()', 'getUser' in app.manifest().endpoints);

  app.ws.close(conn);
  console.log('\nall good ⚡');
}

if (process.argv.includes('--run') || import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
