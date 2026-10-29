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

/** 80% of a Rayleigh draw falls inside one radius. */
const CONE_SIGMA = 1 / Math.sqrt(-2 * Math.log(0.2));

export function roundsFromBurst(burst: FireBurst): RoundState[] {
  const spacingMs = 1000 / burst.rateHz;
  const origin: Geodetic = { latDeg: burst.latDeg, lonDeg: burst.lonDeg, altMeters: burst.altMeters };
  const cone = burst.coneRad && burst.coneRad > 0 ? aimCone(burst.northMps, burst.eastMps, burst.upMps) : null;
  const seed = burst.coneSeed ?? burst.seq;
  return Array.from({ length: burst.count }, (_, index) => {
    let northMps = burst.northMps;
    let eastMps = burst.eastMps;
    let upMps = burst.upMps;
    if (cone && burst.coneRad) {
      const offset = coneOffset(seed, index, burst.coneRad);
      const speed = cone.speed;
      northMps += (cone.rx * offset.yaw + cone.ux * offset.pitch) * speed;
      eastMps += (cone.ry * offset.yaw + cone.uy * offset.pitch) * speed;
      upMps += (cone.rz * offset.yaw + cone.uz * offset.pitch) * speed;
      const next = Math.hypot(northMps, eastMps, upMps);
      if (next > 1e-6) {
        const scale = speed / next;
        northMps *= scale;
        eastMps *= scale;
        upMps *= scale;
      }
    }
    return {
      id: `${burst.shooterId}:${burst.seq}:${index}`,
      shooterId: burst.shooterId,
      seq: burst.seq,
      index,
      birthMs: burst.tMs + index * spacingMs,
      origin,
      northM: 0,
      eastM: 0,
      upM: 0,
      northMps,
      eastMps,
      upMps,
      dragPerSec: burst.dragPerSec,
      lifeS: burst.lifeS,
      ageS: 0,
      done: false,
    };
  });
}

function aimCone(north: number, east: number, up: number) {
  const speed = Math.hypot(north, east, up);
  const ax = Math.abs(north) < 0.9 * speed ? 1 : 0;
  const ay = ax === 0 ? 1 : 0;
  let rx = east * 0 - up * ay;
  let ry = up * ax - north * 0;
  let rz = north * ay - east * ax;
  const right = Math.hypot(rx, ry, rz) || 1;
  rx /= right; ry /= right; rz /= right;
  let ux = ry * up - rz * east;
  let uy = rz * north - rx * up;
  let uz = rx * east - ry * north;
  const lifted = Math.hypot(ux, uy, uz) || 1;
  ux /= lifted; uy /= lifted; uz /= lifted;
  return { speed, rx, ry, rz, ux, uy, uz };
}

function hash32(seed: number, index: number, salt: number): number {
  let x = (Math.imul(seed, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

function coneOffset(seed: number, index: number, radiusRad: number): { yaw: number; pitch: number } {
  const unit = (hash32(seed, index, 1) + 0.5) / 4294967296;
  const angle = ((hash32(seed, index, 2) + 0.5) / 4294967296) * Math.PI * 2;
  const magnitude = Math.min(radiusRad * 3, radiusRad * CONE_SIGMA * Math.sqrt(-2 * Math.log(Math.max(1e-9, unit))));
  return { yaw: magnitude * Math.cos(angle), pitch: magnitude * Math.sin(angle) };
}

/** Same step as `stepRound`, writing into the round so a burst does not allocate per tick. */
export function stepRoundInPlace(round: RoundState, dtS: number): void {
  if (round.done || !(dtS > 0)) return;
  const ageS = round.ageS + dtS;
  if (ageS > round.lifeS) {
    round.ageS = ageS;
    round.done = true;
    return;
  }
  const speed = Math.hypot(round.northMps, round.eastMps, round.upMps);
  const drag = round.dragPerSec * speed * dtS;
  const northMps = round.northMps - drag * round.northMps;
  const eastMps = round.eastMps - drag * round.eastMps;
  const upMps = round.upMps - drag * round.upMps - GRAVITY_MPS2 * dtS;
  round.northM += northMps * dtS;
  round.eastM += eastMps * dtS;
  round.upM += upMps * dtS;
  round.northMps = northMps;
  round.eastMps = eastMps;
  round.upMps = upMps;
  round.ageS = ageS;
}

export function stepRound(round: RoundState, dtS: number): RoundState {
  if (round.done || !(dtS > 0)) return round;
  const next = { ...round };
  stepRoundInPlace(next, dtS);
  return next;
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
