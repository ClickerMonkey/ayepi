/**
 * Reading a server-sent event stream: each event's `data` lines, joined and parsed as JSON. Comments, other fields
 * and data that isn't JSON are skipped.
 *
 * @module
 */

/**
 * Read events until the stream ends or `onData` returns `true` (the stream is then cancelled). `onData` gets each
 * event's data parsed as JSON.
 */
export async function readEvents(body: ReadableStream<Uint8Array>, onData: (data: unknown) => boolean): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  /** End of one event: hand over its data. `true` stops reading. */
  const dispatch = (): boolean => {
    const text = data.join('\n');
    data = [];
    if (text === '') { return false; }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return false;
    }
    return onData(parsed);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { dispatch(); return; }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.search(/\r?\n/);
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(buffer[newline] === '\r' ? newline + 2 : newline + 1);
        if (line === '') {
          if (dispatch()) { await reader.cancel(); return; }
        } else if (line.startsWith('data:')) {
          data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
        }
        newline = buffer.search(/\r?\n/);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
