import { describe, expect, it, vi } from "vitest";
import { createMultiplayerAvailability, idlePrefetchAllowed } from "../src/availability";

function feature(options: { downloading?: () => boolean; connection?: () => { saveData?: boolean; effectiveType?: string } | undefined } = {}) {
  const load = vi.fn().mockResolvedValue({});
  const availability = createMultiplayerAvailability({
    downloading: options.downloading ?? (() => false),
    connection: options.connection,
    load,
  });
  return { availability, load };
}

describe("multiplayer availability", () => {
  it("stays off and downloads nothing until a pilot turns it on", () => {
    const { availability, load } = feature();
    expect(availability.enabled).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it("downloads immediately when turned on, including while other downloads are running and on save-data", async () => {
    const { availability, load } = feature({
      downloading: () => true,
      connection: () => ({ saveData: true, effectiveType: "2g" }),
    });
    await availability.enable();
    await availability.enable();
    expect(availability.enabled).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("prefetches only while idle, with a clear pipe and a connection that is not saving data", () => {
    const clear = feature();
    expect(clear.availability.prefetchIfIdle()).toBe(true);
    expect(clear.load).toHaveBeenCalledTimes(1);
    expect(clear.availability.prefetchIfIdle()).toBe(false);

    const busy = feature({ downloading: () => true });
    expect(busy.availability.prefetchIfIdle()).toBe(false);
    expect(busy.load).not.toHaveBeenCalled();

    for (const connection of [{ saveData: true }, { effectiveType: "2g" }, { effectiveType: "slow-2g" }]) {
      const saved = feature({ connection: () => connection });
      expect(saved.availability.prefetchIfIdle()).toBe(false);
      expect(saved.load).not.toHaveBeenCalled();
    }
    expect(idlePrefetchAllowed({ effectiveType: "4g" })).toBe(true);
  });

  it("does not turn the feature on by prefetching, and a failed download can be tried again", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({});
    const availability = createMultiplayerAvailability({ downloading: () => false, load });
    expect(availability.prefetchIfIdle()).toBe(true);
    expect(availability.enabled).toBe(false);
    await expect(availability.enable()).rejects.toThrow("offline");
    await availability.enable();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("handles an unattended failed idle prefetch and retries on the next idle", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({});
    const availability = createMultiplayerAvailability({ downloading: () => false, load });
    expect(availability.prefetchIfIdle()).toBe(true);
    // Let the event loop surface any unhandled rejection before the next attempt.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(availability.enabled).toBe(false);
    expect(availability.prefetchIfIdle()).toBe(true);
    await availability.enable();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("loads the session module itself when no loader is passed", async () => {
    const availability = createMultiplayerAvailability({ downloading: () => false });
    await availability.enable();
    const session = await import("../src/sessionWorld");
    expect(session.createSessionWorld).toEqual(expect.any(Function));
  });
});
