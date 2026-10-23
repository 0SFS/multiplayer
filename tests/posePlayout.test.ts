import { describe, expect, it } from "vitest";
import { EARTH_RADIUS_M } from "../src/geodetic";
import { FT_TO_M } from "../src/protocol";
import { POSE_EXTRAPOLATE_MAX_MS, POSE_STALE_MS, showPose } from "../src/posePlayout";
import { pose } from "./fixture";

describe("pose playout", () => {
  it("advances along the ground velocity and the yaw rate, and clamps the lead", () => {
    const shown = showPose(pose({ tMs: 0, northVelocityFps: 100, yawRateRadPerSec: 0.1 }), 1_000);
    const leadS = POSE_EXTRAPOLATE_MAX_MS / 1000;
    const northM = 100 * FT_TO_M * leadS;
    expect(shown.leadMs).toBe(POSE_EXTRAPOLATE_MAX_MS);
    expect(shown.stale).toBe(true);
    expect(shown.pose.latDeg).toBeCloseTo(45 + (northM / EARTH_RADIUS_M) * (180 / Math.PI), 8);
    expect(shown.pose.headingRad).toBeCloseTo(0.1 * leadS, 8);
  });

  it("holds a paused aircraft where it was", () => {
    const shown = showPose(pose({ tMs: 0, northVelocityFps: 100 }), POSE_STALE_MS + 1, true);
    expect(shown.held).toBe(true);
    expect(shown.leadMs).toBe(0);
    expect(shown.pose.latDeg).toBe(45);
  });
});
