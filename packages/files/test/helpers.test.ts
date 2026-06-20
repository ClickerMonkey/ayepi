/** The stream helpers: normalizing every FileBody kind and collecting a stream to bytes. */
import { describe, it, expect } from 'vitest';
import { toStream, collect } from '../src/index';

const bytes = (b: BodyInit | ReadableStream<Uint8Array> | Uint8Array | Blob | string) => collect(toStream(b as never));

describe('toStream / collect', () => {
  it('normalizes a string, Uint8Array, Blob, and ReadableStream', async () => {
    expect(new TextDecoder().decode(await bytes('hi'))).toBe('hi');
    expect([...(await bytes(new Uint8Array([1, 2])))]).toEqual([1, 2]);
    expect(new TextDecoder().decode(await bytes(new Blob(['blobby'])))).toBe('blobby');

    const rs = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([9]));
        c.enqueue(new Uint8Array([8]));
        c.close();
      },
    });
    expect([...(await collect(rs))]).toEqual([9, 8]); // a real stream passes through untouched + collects across chunks
  });

  it('passes an existing ReadableStream through by identity', () => {
    const rs = new ReadableStream<Uint8Array>();
    expect(toStream(rs)).toBe(rs);
  });
});
