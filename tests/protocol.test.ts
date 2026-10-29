import { describe, expect, it } from "vitest";
import { encodeMessage, parseMessage, PROTOCOL_VERSION } from "../src/protocol";
import { burst, launch, pose } from "./fixture";

const secret = "a".repeat(43);

describe("session messages", () => {
  it("round-trips a pose, a burst and a launch", () => {
    for (const message of [
      { type: "pose" as const, pose: pose() },
      { type: "fire" as const, burst: burst() },
      { type: "launch" as const, launch: launch() },
      { type: "hello" as const, v: PROTOCOL_VERSION, pilotId: "a", secret, aircraftId: "f-35b", damageImplementations: ["health-v1"] as const },
    ]) {
      const wire = encodeMessage(message);
      expect(wire).not.toBeNull();
      expect(parseMessage(wire!)).toEqual(message);
    }
  });

  it("rejects a bad join secret, a non-finite pose and an oversized frame", () => {
    const hello = encodeMessage({ type: "hello", v: PROTOCOL_VERSION, pilotId: "a", secret, aircraftId: "f-35b", damageImplementations: ["health-v1"] });
    expect(parseMessage(hello!.replace(secret, "short"))).toBeNull();
    expect(parseMessage(JSON.stringify({ type: "pose", pose: { ...pose(), latDeg: null } }))).toBeNull();
    expect(parseMessage("x".repeat(2_000))).toBeNull();
    expect(parseMessage(JSON.stringify({ type: "fire", burst: burst({ count: 41 }) }))).toBeNull();
  });

  it("accepts optional health without inventing health for older peers", () => {
    for (const health of [undefined, 0, 62.5, 100]) {
      const snapshot = pose(health === undefined ? {} : { health });
      expect(parseMessage(encodeMessage({ type: "pose", pose: snapshot })!)).toEqual({ type: "pose", pose: snapshot });
    }
    for (const health of [-1, 101, null, "75", Infinity]) {
      expect(parseMessage(JSON.stringify({ type: "pose", pose: { ...pose(), health } }))).toBeNull();
    }
  });

  it("validates shared settings, capabilities and revisions before dispatch", () => {
    const settings = { damageImplementation: "health-v1", settingsEditors: "host" };
    expect(parseMessage(JSON.stringify({ type: "shared-settings", revision: 0, settings }))).toMatchObject({ settings });
    for (const message of [
      { type: "shared-settings", revision: -1, settings },
      { type: "shared-settings", revision: 0, settings: { ...settings, damageImplementation: "physical-v1" } },
      { type: "shared-settings", revision: 0, settings: { ...settings, settingsEditors: "guest" } },
      { type: "shared-settings-request", requestId: 1, baseRevision: 0, patch: {} },
      { type: "shared-settings-request", requestId: 1, baseRevision: 0, patch: { unknown: true } },
      { type: "shared-settings-ready", revision: 0.5 },
      { type: "shared-settings-result", requestId: 1, error: "arbitrary error" },
      { type: "hello", v: PROTOCOL_VERSION, pilotId: "a", secret, aircraftId: "f-35b", sessionId: "short" },
      { type: "hello", v: PROTOCOL_VERSION, pilotId: "a", secret, aircraftId: "f-35b" },
      { type: "hello", v: 1, pilotId: "a", secret, aircraftId: "f-35b", damageImplementations: ["health-v1"] },
    ]) expect(parseMessage(JSON.stringify(message))).toBeNull();
  });

  it("round-trips flight-server membership messages and keeps the join secret off a guest welcome", () => {
    const settings = { damageImplementation: "health-v1" as const, settingsEditors: "host" as const };
    const sessionId = "a".repeat(22);
    for (const message of [
      { type: "open-flight" as const, v: PROTOCOL_VERSION, pilotId: "host", aircraftId: "f-35b", damageImplementations: ["health-v1"] as const, settings },
      { type: "welcome" as const, role: "host" as const, sessionId, secret, expiresAtMs: 10, serverTimeMs: 1, revision: 0, settings },
      { type: "welcome" as const, role: "guest" as const, sessionId, expiresAtMs: 10, serverTimeMs: 1, revision: 0, settings },
      { type: "member" as const, pilotId: "host", aircraftId: "f-35b", host: true, present: true },
      { type: "removed" as const, pilotId: "guest", reason: "strikes" as const },
    ]) expect(parseMessage(encodeMessage(message)!)).toEqual(message);
    expect(parseMessage(JSON.stringify({ type: "welcome", role: "guest", sessionId, secret, expiresAtMs: 10, serverTimeMs: 1, revision: 0, settings }))).toBeNull();
  });
});
