/**
 * Reading a server-sent event stream: each event's name and `data` lines ({@link readEventStream}), or each event's
 * data parsed as JSON ({@link readEvents}). Comments and other fields are skipped.
 *
 * @module
 */

/** One server-sent event: its name (`message` when the stream names none) and its data lines, joined. */
export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

/**
 * Read events until the stream ends or `onEvent` returns `true` (the stream is then cancelled). An event with no data
 * is skipped.
 */
export async function readEventStream(body: ReadableStream<Uint8Array>, onEvent: (event: SseEvent) => boolean): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let name = 'message';
  /** End of one event: hand it over. `true` stops reading. */
  const dispatch = (): boolean => {
    const text = data.join('\n');
    const event = name;
    data = [];
    name = 'message';
    return text === '' ? false : onEvent({ event, data: text });
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
        } else if (line.startsWith('event:')) {
          name = line.slice(6).trim();
        }
        newline = buffer.search(/\r?\n/);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Read events until the stream ends or `onData` returns `true` (the stream is then cancelled). `onData` gets each
 * event's data parsed as JSON, whatever the event's name; data that isn't JSON is skipped.
 */
export async function readEvents(body: ReadableStream<Uint8Array>, onData: (data: unknown) => boolean): Promise<void> {
  await readEventStream(body, (event) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return false;
    }
    return onData(parsed);
  });
}
