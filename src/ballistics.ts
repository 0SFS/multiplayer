/**
 * Shared bullet step. Semi-implicit Euler, quadratic drag, constant gravity.
 *
 * Every peer runs this from the burst, on a fixed step, from the muzzle.
 * Positions on the wire would let the shooter invent a tracer.
 */

import { geodeticFrom, type Geodetic } from "./geodetic";
import type { FireBurst } from "./protocol";

export const GRAVITY_MPS2 = 9.80665;
export const BALLISTIC_STEP_S = 1 / 60;

export interface RoundState {
  id: string;
  shooterId: string;
  seq: number;
  index: number;
  birthMs: number;
  origin: Geodetic;
  northM: number;
  eastM: number;
  upM: number;
  northMps: number;
  eastMps: number;
  upMps: number;
  dragPerSec: number;
  lifeS: number;
  ageS: number;
  done: boolean;
}

export function roundsFromBurst(burst: FireBurst): RoundState[] {
  const spacingMs = 1000 / burst.rateHz;
  const origin: Geodetic = { latDeg: burst.latDeg, lonDeg: burst.lonDeg, altMeters: burst.altMeters };
  return Array.from({ length: burst.count }, (_, index) => ({
    id: `${burst.shooterId}:${burst.seq}:${index}`,
    shooterId: burst.shooterId,
    seq: burst.seq,
    index,
    birthMs: burst.tMs + index * spacingMs,
    origin,
    northM: 0,
    eastM: 0,
    upM: 0,
    northMps: burst.northMps,
    eastMps: burst.eastMps,
    upMps: burst.upMps,
    dragPerSec: burst.dragPerSec,
    lifeS: burst.lifeS,
    ageS: 0,
    done: false,
  }));
}

export function stepRound(round: RoundState, dtS: number): RoundState {
  if (round.done || !(dtS > 0)) return round;
  const ageS = round.ageS + dtS;
  if (ageS > round.lifeS) return { ...round, ageS, done: true };
  const speed = Math.hypot(round.northMps, round.eastMps, round.upMps);
  const drag = round.dragPerSec * speed * dtS;
  const northMps = round.northMps - drag * round.northMps;
  const eastMps = round.eastMps - drag * round.eastMps;
  const upMps = round.upMps - drag * round.upMps - GRAVITY_MPS2 * dtS;
  return {
    ...round,
    northM: round.northM + northMps * dtS,
    eastM: round.eastM + eastMps * dtS,
    upM: round.upM + upMps * dtS,
    northMps,
    eastMps,
    upMps,
    ageS,
    done: false,
  };
}

export function roundGeodetic(round: RoundState): Geodetic {
  return geodeticFrom(round.origin, { northM: round.northM, eastM: round.eastM, downM: -round.upM });
}

/** Step a round from rest at its birth up to `nowMs`, on the shared grid. */
export function roundAt(round: RoundState, nowMs: number): RoundState {
  if (nowMs < round.birthMs) return round;
  const steps = Math.floor((nowMs - round.birthMs) / 1000 / BALLISTIC_STEP_S);
  let state = round;
  for (let i = 0; i < steps && !state.done; i++) state = stepRound(state, BALLISTIC_STEP_S);
  return state;
}
