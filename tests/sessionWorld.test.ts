import { describe, expect, it } from "vitest";
import { POSE_STALE_MS } from "../src/posePlayout";
import { encodeMessage, parseMessage } from "../src/protocol";
import { createSessionWorld } from "../src/sessionWorld";
import { burst, launch, pose } from "./fixture";

describe("session world", () => {
  it("shows the same aircraft, rounds and missile on two peers that trade messages", () => {
    const host = createSessionWorld();
    const guest = createSessionWorld();
    const messages = [
      { type: "pose" as const, pose: pose({ pilotId: "a", tMs: 0, latDeg: 0, lonDeg: 0, altMeters: 5_000 }) },
      { type: "pose" as const, pose: pose({
        pilotId: "b", seq: 1, tMs: 0, latDeg: 0, lonDeg: 0.2, altMeters: 5_000, northVelocityFps: 0,
      }) },
      { type: "fire" as const, burst: burst({ tMs: 0, latDeg: 0, lonDeg: 0, altMeters: 5_000, count: 2, rateHz: 10 }) },
      { type: "launch" as const, launch: launch({
        tMs: 0, latDeg: 0, lonDeg: 0, altMeters: 5_000, northMps: 300, speedMps: 300,
      }) },
    ];
    for (const message of messages) {
      const wire = encodeMessage(message);
      const parsed = parseMessage(wire!);
      host.ingest(parsed!);
      guest.ingest(parsed!);
    }
    expect(guest.render(2_000)).toEqual(host.render(2_000));
    const view = host.render(2_000);
    expect(view.aircraft).toHaveLength(2);
    expect(view.rounds.length).toBeGreaterThan(0);
    expect(view.missiles[0]?.eastMps).toBeGreaterThan(0);
  });

  it("keeps the newest pose, holds on pause, and goes stale", () => {
    const world = createSessionWorld();
    world.ingest({ type: "pose", pose: pose({ seq: 2, tMs: 0, northVelocityFps: 100 }) });
    world.ingest({ type: "pose", pose: pose({ seq: 1, tMs: 0, latDeg: 10 }) });
    expect(world.render(0).aircraft[0]?.pose.seq).toBe(2);
    world.ingest({ type: "held", pilotId: "a", tMs: 0 });
    expect(world.render(1_000).aircraft[0]).toMatchObject({ held: true, leadMs: 0 });
    const fresh = createSessionWorld();
    fresh.ingest({ type: "pose", pose: pose({ tMs: 0, northVelocityFps: 100 }) });
    expect(fresh.render(POSE_STALE_MS + 50).aircraft[0]?.stale).toBe(true);
  });

  it("forgets the oldest burst once a pilot is past the cap", () => {
    const world = createSessionWorld();
    for (let seq = 1; seq <= 9; seq++) {
      world.ingest({ type: "fire", burst: burst({ seq, tMs: 0, count: 1, rateHz: 10 }) });
    }
    const ids = world.render(10).rounds.map(round => round.id);
    expect(ids).not.toContain("a:1:0");
    expect(ids).toContain("a:9:0");
  });
});
