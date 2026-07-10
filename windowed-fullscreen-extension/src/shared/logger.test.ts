import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
  DEFAULT_RING_CAPACITY,
  LOG_CODES,
  Logger,
  type LogEntry,
} from "./logger";

/**
 * Unit tests for the structured diagnostic Logger.
 *
 * Coverage:
 * - Ring-buffer capacity: eviction when full and chronological ordering of
 *   getEntries() (Req 7.1–7.6 rely on a bounded, ordered buffer the options
 *   page can read).
 * - Entry shape: every recorded entry exposes { timestamp, surface, code,
 *   message, context }.
 * - Code emission: each diagnostic helper records its stable code
 *   (player-not-found 7.1, native-control-not-found 7.2, absent-chrome 7.3,
 *   re-render-abandoned 7.5, player-lost 7.6).
 */

/** A controllable monotonic clock for deterministic timestamps. */
function makeClock(start = 1_000): { now: () => number; tick: (ms?: number) => void } {
  let current = start;
  return {
    now: () => current,
    tick: (ms = 1) => {
      current += ms;
    },
  };
}

/** An injectable console sink that records calls per level. */
function makeSink() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("Logger", () => {
  let sink: ReturnType<typeof makeSink>;
  let clock: ReturnType<typeof makeClock>;

  beforeEach(() => {
    sink = makeSink();
    clock = makeClock();
  });

  describe("entry shape", () => {
    it("records an entry with timestamp, surface, code, message, and context", () => {
      const logger = new Logger("content", { console: sink, now: clock.now });

      const entry = logger.log(
        LOG_CODES.PLAYER_NOT_FOUND,
        "no player",
        { selector: "video.html5-main-video" },
      );

      expect(entry).toMatchObject({
        timestamp: 1_000,
        surface: "content",
        code: "player-not-found",
        message: "no player",
        context: { selector: "video.html5-main-video" },
      });
      // The buffered copy carries the same shape.
      const [stored] = logger.getEntries();
      expect(Object.keys(stored)).toEqual(
        expect.arrayContaining(["timestamp", "surface", "code", "message", "context"]),
      );
    });

    it("defaults context to an empty object when omitted", () => {
      const logger = new Logger("background", { console: sink, now: clock.now });

      const entry = logger.log(LOG_CODES.PLAYER_LOST, "gone");

      expect(entry.context).toEqual({});
    });

    it("stamps each entry with the current value of the injected clock", () => {
      const logger = new Logger("options", { console: sink, now: clock.now });

      logger.log(LOG_CODES.ABSENT_CHROME, "first");
      clock.tick(50);
      logger.log(LOG_CODES.ABSENT_CHROME, "second");

      const entries = logger.getEntries();
      expect(entries.map((e) => e.timestamp)).toEqual([1_000, 1_050]);
    });

    it("binds the entry surface to the logger's surface", () => {
      const popup = new Logger("popup", { console: sink, now: clock.now });
      expect(popup.log(LOG_CODES.PLAYER_LOST, "m").surface).toBe("popup");
    });
  });

  describe("ring-buffer capacity", () => {
    it("retains entries up to capacity without eviction", () => {
      const logger = new Logger("content", {
        console: sink,
        now: clock.now,
        capacity: 3,
      });

      for (let i = 0; i < 3; i++) {
        clock.tick(10);
        logger.log(LOG_CODES.PLAYER_NOT_FOUND, `m${i}`);
      }

      expect(logger.size).toBe(3);
      expect(logger.getEntries().map((e) => e.message)).toEqual(["m0", "m1", "m2"]);
    });

    it("evicts the oldest entry (FIFO) once capacity is exceeded", () => {
      const logger = new Logger("content", {
        console: sink,
        now: clock.now,
        capacity: 3,
      });

      for (let i = 0; i < 5; i++) {
        clock.tick(10);
        logger.log(LOG_CODES.PLAYER_NOT_FOUND, `m${i}`);
      }

      // Capacity caps the size; the two oldest (m0, m1) are evicted.
      expect(logger.size).toBe(3);
      expect(logger.getEntries().map((e) => e.message)).toEqual(["m2", "m3", "m4"]);
    });

    it("returns entries in chronological order (oldest first) after wrapping", () => {
      const logger = new Logger("content", {
        console: sink,
        now: clock.now,
        capacity: 4,
      });

      for (let i = 0; i < 10; i++) {
        clock.tick(5);
        logger.log(LOG_CODES.PLAYER_NOT_FOUND, `m${i}`);
      }

      const entries = logger.getEntries();
      expect(entries.map((e) => e.message)).toEqual(["m6", "m7", "m8", "m9"]);
      // Timestamps are strictly increasing => chronological order holds.
      const timestamps = entries.map((e) => e.timestamp);
      expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
    });

    it("getEntries returns a copied array so structural mutation does not affect the buffer", () => {
      const logger = new Logger("content", { console: sink, now: clock.now });
      logger.log(LOG_CODES.PLAYER_LOST, "m");

      const snapshot = logger.getEntries();
      snapshot.push({} as LogEntry);

      const fresh = logger.getEntries();
      expect(fresh).toHaveLength(1);
      expect(fresh[0].message).toBe("m");
    });

    it("clear() empties the buffer and resets ordering for subsequent writes", () => {
      const logger = new Logger("content", {
        console: sink,
        now: clock.now,
        capacity: 3,
      });

      for (let i = 0; i < 5; i++) logger.log(LOG_CODES.PLAYER_NOT_FOUND, `m${i}`);
      logger.clear();
      expect(logger.size).toBe(0);
      expect(logger.getEntries()).toEqual([]);

      logger.log(LOG_CODES.PLAYER_NOT_FOUND, "after");
      expect(logger.getEntries().map((e) => e.message)).toEqual(["after"]);
    });

    it("uses the documented default capacity when none is provided", () => {
      const logger = new Logger("content", { console: sink, now: clock.now });

      for (let i = 0; i < DEFAULT_RING_CAPACITY + 5; i++) {
        logger.log(LOG_CODES.PLAYER_NOT_FOUND, `m${i}`);
      }

      expect(logger.size).toBe(DEFAULT_RING_CAPACITY);
    });

    it("falls back to the default capacity for non-positive capacities", () => {
      const logger = new Logger("content", {
        console: sink,
        now: clock.now,
        capacity: 0,
      });
      for (let i = 0; i < DEFAULT_RING_CAPACITY + 1; i++) {
        logger.log(LOG_CODES.PLAYER_NOT_FOUND, `m${i}`);
      }
      expect(logger.size).toBe(DEFAULT_RING_CAPACITY);
    });
  });

  describe("diagnostic code emission", () => {
    it("emits player-not-found (Req 7.1)", () => {
      const logger = new Logger("content", { console: sink, now: clock.now });
      const entry = logger.playerNotFound("player missing", { url: "x" });

      expect(entry.code).toBe(LOG_CODES.PLAYER_NOT_FOUND);
      expect(entry.code).toBe("player-not-found");
      expect(logger.getEntries().at(-1)?.code).toBe("player-not-found");
    });

    it("emits native-control-not-found (Req 7.2)", () => {
      const logger = new Logger("content", { console: sink, now: clock.now });
      const entry = logger.nativeControlNotFound("button missing");

      expect(entry.code).toBe(LOG_CODES.NATIVE_CONTROL_NOT_FOUND);
      expect(entry.code).toBe("native-control-not-found");
    });

    it("emits absent-chrome (Req 7.3)", () => {
      const logger = new Logger("content", { console: sink, now: clock.now });
      const entry = logger.absentChrome("sidebar absent", { selector: "#secondary" });

      expect(entry.code).toBe(LOG_CODES.ABSENT_CHROME);
      expect(entry.code).toBe("absent-chrome");
    });

    it("emits re-render-abandoned (Req 7.5)", () => {
      const logger = new Logger("content", { console: sink, now: clock.now });
      const entry = logger.reRenderAbandoned("gave up after 30s", { attempts: 5 });

      expect(entry.code).toBe(LOG_CODES.RE_RENDER_ABANDONED);
      expect(entry.code).toBe("re-render-abandoned");
    });

    it("emits player-lost (Req 7.6)", () => {
      const logger = new Logger("content", { console: sink, now: clock.now });
      const entry = logger.playerLost("player removed from DOM");

      expect(entry.code).toBe(LOG_CODES.PLAYER_LOST);
      expect(entry.code).toBe("player-lost");
    });

    it("records every diagnostic case to the buffer with correct codes", () => {
      const logger = new Logger("content", { console: sink, now: clock.now });

      logger.playerNotFound("a");
      logger.nativeControlNotFound("b");
      logger.absentChrome("c");
      logger.reRenderAbandoned("d");
      logger.playerLost("e");

      expect(logger.getEntries().map((e) => e.code)).toEqual([
        "player-not-found",
        "native-control-not-found",
        "absent-chrome",
        "re-render-abandoned",
        "player-lost",
      ]);
    });
  });

  describe("console mirroring", () => {
    it("mirrors entries to the injected sink at the default warn level", () => {
      const logger = new Logger("content", { console: sink, now: clock.now });
      logger.playerNotFound("missing", { selector: "video" });

      expect(sink.warn).toHaveBeenCalledTimes(1);
      expect(sink.warn).toHaveBeenCalledWith(
        "[wfs:content:player-not-found]",
        "missing",
        { selector: "video" },
      );
      expect(sink.error).not.toHaveBeenCalled();
    });

    it("does not mirror to the console when mirroring is disabled", () => {
      const logger = new Logger("content", {
        console: sink,
        now: clock.now,
        mirrorToConsole: false,
      });
      logger.playerLost("silent");

      expect(sink.warn).not.toHaveBeenCalled();
      // Buffer still receives the entry.
      expect(logger.size).toBe(1);
    });

    it("routes severity levels to the matching sink method", () => {
      const logger = new Logger("content", { console: sink, now: clock.now });
      logger.log(LOG_CODES.PLAYER_LOST, "e", {}, "error");
      logger.log(LOG_CODES.PLAYER_LOST, "i", {}, "info");
      logger.log(LOG_CODES.PLAYER_LOST, "d", {}, "debug");

      expect(sink.error).toHaveBeenCalledTimes(1);
      expect(sink.info).toHaveBeenCalledTimes(1);
      expect(sink.debug).toHaveBeenCalledTimes(1);
    });
  });

  describe("createLogger factory", () => {
    it("creates a Logger bound to the given surface", () => {
      const logger = createLogger("background", { console: sink, now: clock.now });
      expect(logger).toBeInstanceOf(Logger);
      expect(logger.log(LOG_CODES.PLAYER_LOST, "m").surface).toBe("background");
    });
  });
});
