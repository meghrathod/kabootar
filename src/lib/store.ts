/**
 * Minimal observable store for useSyncExternalStore. Updates can be
 * throttled so high-frequency progress events don't re-render every chunk.
 */
export class Store<T extends object> {
  private listeners = new Set<() => void>();
  private pending = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private state: T,
    private throttleMs = 0,
  ) {}

  get = (): T => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  set(update: Partial<T> | ((s: T) => Partial<T>), immediate = false) {
    const patch = typeof update === "function" ? update(this.state) : update;
    this.state = { ...this.state, ...patch };
    if (immediate || this.throttleMs === 0) {
      this.flush();
    } else if (!this.pending) {
      this.pending = true;
      this.timer = setTimeout(() => this.flush(), this.throttleMs);
    }
  }

  private flush() {
    this.pending = false;
    clearTimeout(this.timer);
    for (const fn of this.listeners) fn();
  }
}

type Handler<A extends unknown[]> = (...args: A) => void;

/** Tiny typed event emitter. */
export class Emitter<E extends Record<string, unknown[]>> {
  private handlers: { [K in keyof E]?: Set<Handler<E[K]>> } = {};

  on<K extends keyof E>(event: K, fn: Handler<E[K]>): () => void {
    (this.handlers[event] ??= new Set()).add(fn);
    return () => this.handlers[event]?.delete(fn);
  }

  emit<K extends keyof E>(event: K, ...args: E[K]) {
    for (const fn of this.handlers[event] ?? []) fn(...args);
  }
}
