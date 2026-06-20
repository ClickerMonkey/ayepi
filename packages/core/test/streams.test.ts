import { describe, it, expect } from 'vitest';
import { app, inProcess } from './fixture';

describe('raw streamOut', () => {
  const { sdk } = inProcess();
  it('return-style CSV stream', async () => {
    const stream = await sdk.call('exportCsv', { rows: 3 });
    const csv = await new Response(stream).text();
    expect(csv.startsWith('id,name')).toBe(true);
    expect(csv.trim().split('\n')).toHaveLength(4);
  });
  it('pipe-style zip with dynamic download() filename', async () => {
    const url = sdk.url('downloadZip', { name: 'report' });
    const res = await app.fetch(new Request(url));
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="report.zip"');
    expect(res.headers.get('content-type')).toBe('application/zip');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]); // PK\03\04
  });
  it('commit race: error before first byte → 400', async () => {
    const res = await app.fetch(new Request('http://test/downloadZip')); // missing required ?name → handler throws pre-write
    expect(res.status).toBe(400);
  });
});

describe('length() → Content-Length + Range', () => {
  it('full GET sets Content-Length', async () => {
    const res = await app.fetch(new Request('http://test/downloadLog'));
    expect(res.headers.get('content-length')).toBe('100');
    expect((await res.text()).length).toBe(100);
  });
  it('Range suffix → 206', async () => {
    const res = await app.fetch(new Request('http://test/downloadLog', { headers: { range: 'bytes=90-' } }));
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 90-99/100');
    expect(await res.text()).toBe('0123456789');
  });
  it('Range mid-slice', async () => {
    const res = await app.fetch(new Request('http://test/downloadLog', { headers: { range: 'bytes=10-19' } }));
    expect(res.headers.get('content-length')).toBe('10');
    expect(await res.text()).toBe('0123456789');
  });
  it('Range out of bounds → 416', async () => {
    const res = await app.fetch(new Request('http://test/downloadLog', { headers: { range: 'bytes=500-' } }));
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */100');
  });
  it('HEAD strips body, keeps headers', async () => {
    const res = await app.fetch(new Request('http://test/downloadLog', { method: 'HEAD' }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="log.txt"');
  });
});

describe('typed item streams', () => {
  const { sdk } = inProcess();
  it('NDJSON over http', async () => {
    const rows: number[] = [];
    for await (const r of sdk.call('streamRows', { n: 4 })) {rows.push(r.squared);}
    expect(rows).toEqual([0, 1, 4, 9]);
  });
  it('SSE content-type + framing', async () => {
    const res = await app.fetch(new Request('http://test/tickerSse?n=1'));
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe('data: {"tick":0}\n\n');
  });
  it('SSE decodes client-side', async () => {
    const ticks: number[] = [];
    for await (const t of sdk.call('tickerSse', { n: 3 })) {ticks.push(t.tick);}
    expect(ticks).toEqual([0, 1, 2]);
  });
});

describe('typed duplex (streamIn + streamOut)', () => {
  const { sdk } = inProcess();
  it('over http (NDJSON both ways)', async () => {
    const out: number[] = [];
    for await (const r of sdk.call('enrichEvents', { factor: 10 }, {
      stream: async function* () {
        yield { id: 1, v: 1 };
        yield { id: 2, v: 2 };
        yield { id: 3, v: 3 };
      },
    }))
      {out.push(r.scaled);}
    expect(out).toEqual([10, 20, 30]);
  });
  it('over ws (chunk frames both ways)', async () => {
    const out: number[] = [];
    for await (const r of sdk.call('enrichEvents', { factor: 5 }, {
      transport: 'ws',
      stream: async function* () {
        yield { id: 1, v: 2 };
        yield { id: 2, v: 4 };
      },
    }))
      {out.push(r.scaled);}
    expect(out).toEqual([10, 20]);
  });
  it('raw streamIn counts bytes', async () => {
    const ing = await sdk.call('ingestData', { tag: 't' }, { stream: 'streaming-bytes!' });
    expect(ing.bytes).toBe(16);
  });
});
