/**
 * Structured diagnostic Logger for the Windowed Fullscreen Extension.
 *
 * A thin diagnostic logger used across all surfaces (content script, service
 * worker, options page, popup). It writes structured entries to the extension
 * console and retains the most recent entries in a bounded in-memory ring
 * buffer that the options page can read for troubleshooting.
 *
 * Covers the diagnostic cases called out in the design / requirements:
 * player-not-found (7.1), native-control-not-found (7.2), absent-chrome (7.3),
 * re-render-abandoned (7.5), and player-lost (7.6).
 */

// ---------------------------------------------------------------------------
// Stable diagnostic code set
// ---------------------------------------------------------------------------

/**
 * The stable set of diagnostic codes. Codes are part of the Logger contract:
 * callers reference them by name and tests/UI can match on them, so they must
 * remain stable.
 */
export const LOG_CODES = {
  /** The active Site_Adapter could not locate the video player (Req 7.1). */
  PLAYER_NOT_FOUND: "player-not-found",
  /** The active Site_Adapter could not locate the native control (Req 7.2). */
  NATIVE_CONTROL_NOT_FOUND: "native-control-not-found",
  /** A Site_Chrome selector resolved to no element on entry (Req 7.3). */
  ABSENT_CHROME: "absent-chrome",
  /** Re-render attempts were abandoned after controls stayed absent (Req 7.5). */
  RE_RENDER_ABANDONED: "re-render-abandoned",
  /** The active player element was removed from the DOM while active (Req 7.6). */
  PLAYER_LOST: "player-lost",
} as const;

/** A diagnostic code string drawn from the stable {@link LOG_CODES} set. */
export type LogCode = (typeof LOG_CODES)[keyof typeof LOG_CODES];

/**
 * The runtime surface a log entry originated from. Mirrors the four MV3
 * surfaces plus a generic fallback.
 */
export type LogSurface = "content" | "background" | "options" | "popup";

/** Severity level for an entry. Diagnostic cases default to "warn". */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** A single structured diagnostic entry. */
export interface LogEntry {
  /** Epoch milliseconds at which the entry was recorded. */
  timestamp: number;
  /** The surface that produced the entry. */
  surface: LogSurface;
  /** A stable diagnostic code from {@link LOG_CODES}. */
  code: LogCode;
  /** Human-readable message describing the event. */
  message: string;
  /** Arbitrary structured context (selectors, urls, counts, etc.). */
  context: Record<string, unknown>;
  /** Severity level. */
  level: LogLevel;
}

/** Default capacity of the in-memory ring buffer. */
export const DEFAULT_RING_CAPACITY = 200;

export interface LoggerOptions {
  /** Maximum number of entries retained in the ring buffer. */
  capacity?: number;
  /** Console sink; defaults to the global `console`. Injectable for tests. */
  console?: Pick<Console, "debug" | "info" | "warn" | "error">;
  /** Clock returning epoch milliseconds; defaults to `Date.now`. */
  now?: () => number;
  /** Whether to mirror entries to the console sink. Defaults to true. */
  mirrorToConsole?: boolean;
}

/**
 * A structured logger backed by a fixed-capacity ring buffer.
 *
 * The buffer retains at most `capacity` entries; once full, the oldest entry
 * is overwritten by the newest (FIFO eviction).
 */
export class Logger {
  private readonly capacity: number;
  private readonly sink: Pick<Console, "debug" | "info" | "warn" | "error">;
  private readonly now: () => number;
  private readonly mirrorToConsole: boolean;

  /** Circular storage of entries; length never exceeds `capacity`. */
  private readonly ring: LogEntry[] = [];
  /** Index at which the next entry will be written once the ring is full. */
  private writeIndex = 0;

  constructor(
    private readonly surface: LogSurface,
    options: LoggerOptions = {},
  ) {
    const capacity = options.capacity ?? DEFAULT_RING_CAPACITY;
    this.capacity = capacity > 0 ? Math.floor(capacity) : DEFAULT_RING_CAPACITY;
    this.sink = options.console ?? console;
    this.now = options.now ?? Date.now;
    this.mirrorToConsole = options.mirrorToConsole ?? true;
  }

  /**
   * Record a structured diagnostic entry. Writes to the ring buffer and,
   * unless disabled, mirrors to the console sink.
   */
  log(
    code: LogCode,
    message: string,
    context: Record<string, unknown> = {},
    level: LogLevel = "warn",
  ): LogEntry {
    const entry: LogEntry = {
      timestamp: this.now(),
      surface: this.surface,
      code,
      message,
      context,
      level,
    };

    this.push(entry);

    if (this.mirrorToConsole) {
      this.mirror(entry);
    }

    return entry;
  }

  /** Record that the video player could not be located (Req 7.1). */
  playerNotFound(message: string, context: Record<string, unknown> = {}): LogEntry {
    return this.log(LOG_CODES.PLAYER_NOT_FOUND, message, context);
  }

  /** Record that the native fullscreen control could not be located (Req 7.2). */
  nativeControlNotFound(
    message: string,
    context: Record<string, unknown> = {},
  ): LogEntry {
    return this.log(LOG_CODES.NATIVE_CONTROL_NOT_FOUND, message, context);
  }

  /** Record that a Site_Chrome selector resolved to nothing on entry (Req 7.3). */
  absentChrome(message: string, context: Record<string, unknown> = {}): LogEntry {
    return this.log(LOG_CODES.ABSENT_CHROME, message, context);
  }

  /** Record that re-render attempts were abandoned (Req 7.5). */
  reRenderAbandoned(
    message: string,
    context: Record<string, unknown> = {},
  ): LogEntry {
    return this.log(LOG_CODES.RE_RENDER_ABANDONED, message, context);
  }

  /** Record that the active player was removed from the DOM (Req 7.6). */
  playerLost(message: string, context: Record<string, unknown> = {}): LogEntry {
    return this.log(LOG_CODES.PLAYER_LOST, message, context);
  }

  /**
   * Return a snapshot of the buffered entries in chronological order
   * (oldest first). The returned array is a copy; mutating it does not affect
   * the buffer.
   */
  getEntries(): LogEntry[] {
    if (this.ring.length < this.capacity) {
      // Not yet wrapped: entries are already in insertion order.
      return this.ring.slice();
    }
    // Wrapped: oldest entry sits at writeIndex.
    return [
      ...this.ring.slice(this.writeIndex),
      ...this.ring.slice(0, this.writeIndex),
    ];
  }

  /** Number of entries currently retained (never exceeds capacity). */
  get size(): number {
    return this.ring.length;
  }

  /** Remove all buffered entries. */
  clear(): void {
    this.ring.length = 0;
    this.writeIndex = 0;
  }

  private push(entry: LogEntry): void {
    if (this.ring.length < this.capacity) {
      this.ring.push(entry);
      return;
    }
    this.ring[this.writeIndex] = entry;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
  }

  private mirror(entry: LogEntry): void {
    const prefix = `[wfs:${entry.surface}:${entry.code}]`;
    const fn =
      entry.level === "error"
        ? this.sink.error
        : entry.level === "info"
          ? this.sink.info
          : entry.level === "debug"
            ? this.sink.debug
            : this.sink.warn;
    fn.call(this.sink, prefix, entry.message, entry.context);
  }
}

/**
 * Convenience factory creating a {@link Logger} bound to a surface.
 */
export function createLogger(surface: LogSurface, options?: LoggerOptions): Logger {
  return new Logger(surface, options);
}
