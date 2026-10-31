/** Destination for a received file. Writes are sequential. */
export interface Sink {
  readonly kind: SinkKind;
  /** Where writing actually starts when the sink reopened a partial file. */
  readonly startAt?: number;
  write(chunk: Uint8Array): Promise<void>;
  /** Finish the file. Sinks that keep the data in the browser return it. */
  close(): Promise<File | void>;
  /** Discard a partial file. */
  abort(): Promise<void>;
}

export type SinkKind = "picker" | "stream" | "opfs" | "memory";
