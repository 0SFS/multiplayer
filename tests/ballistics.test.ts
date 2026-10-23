import { describe, expect, it } from "vitest";
import { BALLISTIC_STEP_S, GRAVITY_MPS2, roundAt, roundsFromBurst, stepRound } from "../src/ballistics";
import { burst } from "./fixture";

describe("ballistics", () => {
  it("drops a round under gravity on the shared step", () => {
    const [round] = roundsFromBurst(burst({ upMps: 100, northMps: 0, count: 1, tMs: 0 }));
    const stepped = stepRound(round!, BALLISTIC_STEP_S);
    expect(stepped.upMps).toBeCloseTo(100 - GRAVITY_MPS2 * BALLISTIC_STEP_S, 8);
    expect(stepped.upM).toBeCloseTo(stepped.upMps * BALLISTIC_STEP_S, 8);
  });

  it("spaces a burst and ends a round at the same time on every peer", () => {
    const rounds = roundsFromBurst(burst({ tMs: 0, count: 3, rateHz: 10, lifeS: 1 }));
    expect(rounds.map(round => round.birthMs)).toEqual([0, 100, 200]);
    const at = rounds.map(round => roundAt(round, 2_000));
    expect(at.every(round => round.done)).toBe(true);
    const again = roundsFromBurst(burst({ tMs: 0, count: 3, rateHz: 10, lifeS: 1 })).map(round => roundAt(round, 500));
    const first = rounds.map(round => roundAt(round, 500));
    expect(again.map(round => [round.northM, round.upM])).toEqual(first.map(round => [round.northM, round.upM]));
  });
});
