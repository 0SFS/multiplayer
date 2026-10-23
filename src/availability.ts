/**
 * Multiplayer is off until a pilot turns it on. Its code stays out of the
 * flight's startup graph: the app dynamic-imports this module, and this
 * module dynamic-imports the session.
 *
 * Turning it on downloads immediately. An idle prefetch may download it
 * first, and only when the flight is not already downloading and the
 * connection is not saving data.
 */

const SLOW = new Set(["slow-2g", "2g"]);

/** Flight setting. Default off. The app calls `enable` only when this is on. */
export const MULTIPLAYER_PARAMETER_ID = "osfs.multiplayer";

export interface ConnectionHint {
  saveData?: boolean;
  effectiveType?: string;
}

export function idlePrefetchAllowed(connection: ConnectionHint | undefined): boolean {
  return connection?.saveData !== true && !SLOW.has(connection?.effectiveType ?? "");
}

export function createMultiplayerAvailability(options: {
  /** True while tiles, aircraft, or any other transfer is in flight. */
  downloading: () => boolean;
  connection?: () => ConnectionHint | undefined;
  /** Defaults to the session module. Tests pass their own. */
  load?: () => Promise<unknown>;
} ) {
  let enabled = false;
  let loading: Promise<void> | null = null;
  const load = options.load ?? (() => import("./sessionWorld"));

  function request(): Promise<void> {
    if (loading) return loading;
    let pending: Promise<void>;
    try {
      pending = Promise.resolve(load()).then(() => undefined);
    } catch (error) {
      return Promise.reject(error);
    }
    loading = pending.catch((error: unknown) => {
      loading = null;
      throw error;
    });
    return loading;
  }

  return {
    get enabled() { return enabled; },
    /** The pilot asked. Download now, even if other transfers are running. */
    enable(): Promise<void> {
      enabled = true;
      return request();
    },
    /** Stops the feature. Code already fetched stays fetched. */
    disable(): void { enabled = false; },
    /**
     * One idle attempt. Downloads when the pipe is clear and the connection
     * allows a background fetch. Does not turn the feature on.
     */
    prefetchIfIdle(): boolean {
      if (loading || enabled) return false;
      if (options.downloading()) return false;
      if (!idlePrefetchAllowed(options.connection?.())) return false;
      // A background failure is retried next idle; explicit enable still rejects.
      void request().catch(() => undefined);
      return true;
    },
  };
}

export type MultiplayerAvailability = ReturnType<typeof createMultiplayerAvailability>;
