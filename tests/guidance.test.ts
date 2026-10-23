import { describe, expect, it } from "vitest";
import { BALLISTIC_STEP_S } from "../src/ballistics";
import { missileFromLaunch, stepMissile } from "../src/guidance";
import { launch } from "./fixture";

describe("guidance", () => {
  it("turns toward a target on the beam and stays inside the turn cap", () => {
    let state = missileFromLaunch(launch({
      tMs: 0, latDeg: 0, lonDeg: 0, altMeters: 5_000, maxTurnRadPerSec: 0.5, speedMps: 300, northMps: 300,
    }));
    const target = {
      tMs: 0, latDeg: 0, lonDeg: 0.2, altMeters: 5_000, northMps: 0, eastMps: 0, upMps: 0,
    };
    for (let i = 0; i < 60; i++) {
      const next = stepMissile(state, target, BALLISTIC_STEP_S);
      const turned = angle(state, next);
      expect(turned).toBeLessThanOrEqual(0.5 * BALLISTIC_STEP_S + 1e-4);
      state = next;
    }
    expect(state.eastMps).toBeGreaterThan(0);
    expect(Math.hypot(state.northMps, state.eastMps, state.upMps)).toBeCloseTo(300, 6);
  });

  it("flies the card speed in a straight line with no target", () => {
    let state = missileFromLaunch(launch({ tMs: 0, targetId: undefined, northMps: 100, speedMps: 300 }));
    for (let i = 0; i < 30; i++) state = stepMissile(state, null, BALLISTIC_STEP_S);
    expect(state.eastMps).toBeCloseTo(0, 6);
    expect(state.northMps).toBeCloseTo(300, 6);
  });
});

function angle(a: { northMps: number; eastMps: number; upMps: number }, b: { northMps: number; eastMps: number; upMps: number }): number {
  const am = Math.hypot(a.northMps, a.eastMps, a.upMps);
  const bm = Math.hypot(b.northMps, b.eastMps, b.upMps);
  const dot = (a.northMps * b.northMps + a.eastMps * b.eastMps + a.upMps * b.upMps) / (am * bm);
  return Math.acos(Math.min(1, Math.max(-1, dot)));
}
