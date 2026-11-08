/**
 * A set of listeners, shared by the sources, views and transports.
 *
 * @module
 */

/** Listeners of one kind of event. A listener added while an event is sent hears the next one. */
export class Listeners<T> {
  readonly #listeners = new Set<(value: T) => void>();

  /** Hear every event until the returned function is called. */
  add(listener: (value: T) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** Tell every listener. */
  emit(value: T): void {
    for (const listener of [...this.#listeners]) { listener(value); }
  }

  /** How many listen. */
  get size(): number {
    return this.#listeners.size;
  }
}
