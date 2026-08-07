/**
 * Raw `streamOut` response construction: the demand-driven adaptation of a returned async
 * iterable (backpressure budget, cancellation, mid-stream failure), which headers the library
 * fills in versus which the handler owns, when `Accept-Ranges` may claim `bytes`, and the
 * RFC 6266 encoding of a `Content-Disposition` filename.
 */
import { describe, it, expect } from 'vitest';
import { spec, endpoint, implement, server, type ServerOptions } from '../src/index';

/** A GET endpoint whose handler returns bytes; `mk` builds the one-endpoint app around it. */
const api = spec({ endpoints: { s: endpoint({ method: 'GET', streamOut: 'text/plain' }) } });
type Handler = Parameters<ReturnType<typeof implement<typeof api>>['handlers']>[0]['s'];
const mk = (s: Handler, options?: ServerOptions) => server(api, [implement(api).handlers({ s })], options);

/** A generator that reports how far it has actually run — the whole point of the demand tests. */
function counted(chunkBytes: number, total: number) {
  const chunk = 'x'.repeat(chunkBytes);
  const state = { produced: 0, finallyRuns: 0 };
  return {
    state,
    gen: async function* () {
      try {
        for (let i = 0; i < total; i++) {
          state.produced++;
          yield chunk;
        }
      } finally {
        state.finallyRuns++;
      }
    },
  };
}

/**
 * Wait for the producer to reach `n` steps. Deliberately not a fixed sleep: the upper bound is
 * what these tests assert, and a start()-drain overshoots it before the first poll, so waiting
 * for the lower bound stays exact under any scheduling and cannot flake on a loaded machine.
 */
async function producedAtLeast(state: { produced: number }, n: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (state.produced < n) {
    if (Date.now() > deadline) {throw new Error(`producer stalled at ${state.produced}, expected ${n}`);}
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('a returned async iterable is advanced on demand', () => {
  it('with a zero read-ahead budget the generator runs exactly one step per read', async () => {
    const { state, gen } = counted(8, 1000);
    const app = mk(() => gen(), { streamHighWaterMark: 0 });
    const res = await app.fetch(new Request('http://t/s'));
    const reader = res.body!.getReader();

    /* read() resolves only once its pull enqueued, and with no budget nothing else is pulled,
       so each reading below is already final — no settling window to get wrong */
    expect(state.produced).toBe(0); // the response committed without touching the generator
    await reader.read();
    expect(state.produced).toBe(1);
    await reader.read();
    expect(state.produced).toBe(2);

    await reader.cancel();
  });

  it('reads ahead only up to the byte budget, not to the end of the generator', async () => {
    /* 4 KiB budget over 1 KiB chunks: 4 chunks fill the queue, and the one handed to the
       reader frees room for exactly one more. A generator drained inside start() would be at
       1000 here regardless of the budget. */
    const { state, gen } = counted(1024, 1000);
    const app = mk(() => gen(), { streamHighWaterMark: 4096 });
    const res = await app.fetch(new Request('http://t/s'));
    const reader = res.body!.getReader();
    await reader.read();
    await producedAtLeast(state, 5);

    expect(state.produced).toBe(5);

    await reader.cancel();
  });

  it('resumes as the reader drains, so the whole body still arrives', async () => {
    const { state, gen } = counted(1024, 40);
    const app = mk(() => gen(), { streamHighWaterMark: 4096 });
    const res = await app.fetch(new Request('http://t/s'));
    expect((await res.text()).length).toBe(1024 * 40);
    expect(state.produced).toBe(40);
  });

  it('defaults to a 64 KiB budget when the server sets no high-water mark', async () => {
    const { state, gen } = counted(1024, 1000);
    const app = mk(() => gen());
    const res = await app.fetch(new Request('http://t/s'));
    const reader = res.body!.getReader();
    await reader.read();
    await producedAtLeast(state, 65);

    expect(state.produced).toBe(65); // 64 KiB queued + the one chunk read
    expect(state.produced).toBeLessThan(1000);

    await reader.cancel();
  });
});

describe('cancelling the body stops and cleans up the generator', () => {
  it('runs the generator finally exactly once and stops producing', async () => {
    const { state, gen } = counted(1024, 1000);
    const app = mk(() => gen(), { streamHighWaterMark: 0 });
    const res = await app.fetch(new Request('http://t/s'));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel(); // client disconnected; resolves after the source's cancel()

    expect(state.finallyRuns).toBe(1);
    expect(state.produced).toBe(1); // no further steps after the cancel
  });

  it('does not run the generator finally twice when it already finished', async () => {
    const { state, gen } = counted(4, 3);
    const app = mk(() => gen(), { streamHighWaterMark: 0 });
    const res = await app.fetch(new Request('http://t/s'));
    const reader = res.body!.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) {break;}
    }
    await reader.cancel(); // cancelling a drained body is a no-op

    expect(state.finallyRuns).toBe(1);
  });

  it('calls a hand-rolled return() once on an early exit and never on a clean finish', async () => {
    /* a generator's finally is idempotent, so it cannot see a second cleanup; an explicit
       return() can, and it is the contract a non-generator iterable relies on */
    const spy = (total: number) => {
      const calls = { returns: 0 };
      let i = 0;
      const iterable: AsyncIterable<string> = {
        [Symbol.asyncIterator]: () => ({
          next: async () => (i++ < total ? { done: false as const, value: 'chunk' } : { done: true as const, value: undefined }),
          return: async () => {
            calls.returns++;
            return { done: true as const, value: undefined };
          },
        }),
      };
      return { calls, iterable };
    };

    const early = spy(1000);
    const r1 = (await mk(() => early.iterable, { streamHighWaterMark: 0 }).fetch(new Request('http://t/s'))).body!.getReader();
    await r1.read();
    await r1.cancel();
    expect(early.calls.returns).toBe(1);

    const clean = spy(2);
    const r2 = (await mk(() => clean.iterable, { streamHighWaterMark: 0 }).fetch(new Request('http://t/s'))).body!.getReader();
    for (;;) {
      const { done } = await r2.read();
      if (done) {break;}
    }
    await r2.cancel();
    expect(clean.calls.returns).toBe(0); // it finished on its own; nothing to unwind
  });

  it('tolerates an iterable with no return()', async () => {
    let steps = 0;
    const iterable: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          steps++;
          return { done: false, value: 'chunk' };
        },
      }),
    };
    const app = mk(() => iterable, { streamHighWaterMark: 0 });
    const res = await app.fetch(new Request('http://t/s'));
    const reader = res.body!.getReader();
    await reader.read();
    await expect(reader.cancel()).resolves.toBeUndefined();

    expect(steps).toBe(1);
  });
});

describe('a mid-stream failure truncates rather than succeeding silently', () => {
  it('surfaces the generator throw on the already-committed body', async () => {
    const app = mk(() =>
      (async function* () {
        yield 'ok\n';
        throw new Error('row 2 blew up');
      })(),
    );
    const res = await app.fetch(new Request('http://t/s'));
    expect(res.status).toBe(200); // headers are long gone; only the body can carry the failure
    await expect(new Response(res.body).text()).rejects.toBeDefined();
  });
});

describe('Accept-Ranges only claims what the response can serve', () => {
  it('is none when the handler declared no length', async () => {
    const app = mk(() =>
      (async function* () {
        yield 'hello';
      })(),
    );
    const res = await app.fetch(new Request('http://t/s'));
    expect(res.headers.get('accept-ranges')).toBe('none');
  });

  it('is bytes once the handler declares a length', async () => {
    const app = mk(async ({ out, length }) => {
      length(5);
      const w = out.getWriter();
      await w.write('hello');
      await w.close();
    });
    const res = await app.fetch(new Request('http://t/s'));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe('5');
  });

  it('is none on a non-GET even with a length, because ranges are only parsed for GET', async () => {
    const postApi = spec({ endpoints: { p: endpoint({ method: 'POST', streamOut: 'text/plain' }) } });
    const app = server(postApi, [
      implement(postApi).handlers({
        p: async ({ out, length }) => {
          length(2);
          const w = out.getWriter();
          await w.write('hi');
          await w.close();
        },
      }),
    ]);
    const res = await app.fetch(new Request('http://t/p', { method: 'POST' }));
    expect(res.headers.get('accept-ranges')).toBe('none');
    expect(res.headers.get('content-length')).toBe('2');
  });

  it('a ranged request against a length-less stream really does get a full 200', async () => {
    const app = mk(() =>
      (async function* () {
        yield 'hello';
      })(),
    );
    const res = await app.fetch(new Request('http://t/s', { headers: { range: 'bytes=0-1' } }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello'); // exactly why `bytes` must not be advertised here
  });
});

describe("the handler's own headers survive the library defaults", () => {
  it('keeps a handler opt-out of range support', async () => {
    const app = mk(async ({ out, length, header }) => {
      length(5);
      header('accept-ranges', 'none');
      const w = out.getWriter();
      await w.write('hello');
      await w.close();
    });
    const res = await app.fetch(new Request('http://t/s'));
    expect(res.headers.get('accept-ranges')).toBe('none');
  });

  it('keeps a handler content-type over the declared streamOut type', async () => {
    const app = mk(({ header }) => {
      header('content-type', 'text/csv; charset=utf-8');
      return (async function* () {
        yield 'a,b\n';
      })();
    });
    const res = await app.fetch(new Request('http://t/s'));
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
  });

  it('keeps a handler content-disposition over download()', async () => {
    const app = mk(({ header, download }) => {
      download('forced.txt');
      header('content-disposition', 'inline');
      return (async function* () {
        yield 'x';
      })();
    });
    const res = await app.fetch(new Request('http://t/s'));
    expect(res.headers.get('content-disposition')).toBe('inline');
  });
});

describe('Content-Disposition encodes an untrusted filename', () => {
  const dispositionFor = async (filename: string) => {
    const app = mk(({ download }) => {
      download(filename);
      return (async function* () {
        yield 'x';
      })();
    });
    const res = await app.fetch(new Request('http://t/s'));
    return res;
  };

  it('escapes a quote instead of letting it close the quoted-string', async () => {
    // a name crafted to append a filename* parameter, which recipients prefer over filename
    const res = await dispositionFor('a".txt"; filename*=UTF-8\'\'evil.exe');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="a\\".txt\\"; filename*=UTF-8\'\'evil.exe"');
  });

  it('escapes a backslash', async () => {
    const res = await dispositionFor('a\\b.txt');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="a\\\\b.txt"');
  });

  it('carries non-ASCII in filename* with an ASCII fallback', async () => {
    const res = await dispositionFor('réport 2024.csv');
    expect(res.headers.get('content-disposition')).toBe("attachment; filename=\"r_port 2024.csv\"; filename*=UTF-8''r%C3%A9port%202024.csv");
  });

  it("percent-encodes '()* too, which are not RFC 5987 attr-chars", async () => {
    const res = await dispositionFor("naïve's(1)*.csv");
    expect(res.headers.get('content-disposition')).toBe("attachment; filename=\"na_ve's(1)*.csv\"; filename*=UTF-8''na%C3%AFve%27s%281%29%2A.csv");
  });

  it('neutralizes CR/LF into a valid header instead of a 500', async () => {
    const res = await dispositionFor('a\r\nb.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe("attachment; filename=\"a__b.txt\"; filename*=UTF-8''a%0D%0Ab.txt");
  });

  it('matches the worked example in ayepi-core-endpoints.md', async () => {
    const res = await dispositionFor('réport "24".csv');
    expect(res.headers.get('content-disposition')).toBe(
      "attachment; filename=\"r_port \\\"24\\\".csv\"; filename*=UTF-8''r%C3%A9port%20%2224%22.csv",
    );
  });

  it('leaves a plain filename alone', async () => {
    const res = await dispositionFor('report.zip');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="report.zip"');
  });
});
