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
      { type: "hello" as const, v: PROTOCOL_VERSION, pilotId: "a", secret, aircraftId: "f-35b" },
    ]) {
      const wire = encodeMessage(message);
      expect(wire).not.toBeNull();
      expect(parseMessage(wire!)).toEqual(message);
    }
  });

  it("rejects a bad join secret, a non-finite pose and an oversized frame", () => {
    const hello = encodeMessage({ type: "hello", v: PROTOCOL_VERSION, pilotId: "a", secret, aircraftId: "f-35b" });
    expect(parseMessage(hello!.replace(secret, "short"))).toBeNull();
    expect(parseMessage(JSON.stringify({ type: "pose", pose: { ...pose(), latDeg: null } }))).toBeNull();
    expect(parseMessage("x".repeat(2_000))).toBeNull();
    expect(parseMessage(JSON.stringify({ type: "fire", burst: burst({ count: 41 }) }))).toBeNull();
  });
});
