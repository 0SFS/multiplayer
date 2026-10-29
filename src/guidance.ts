/**
 * Shared missile step. True proportional navigation, then a turn-rate cap,
 * then the card speed.
 *
 * The target is a pose the session already accepted. The missile's place is
 * the integral of this step, not a position the shooter sends.
 */

import { geodeticFrom, nedFrom } from "./geodetic";
import type { MissileLaunch, MissileState } from "./protocol";

export interface TargetSample {
  tMs: number;
  latDeg: number;
  lonDeg: number;
  altMeters: number;
  northMps: number;
  eastMps: number;
  upMps: number;
}

export function missileFromLaunch(launch: MissileLaunch): MissileState {
  return {
    launch,
    tMs: launch.tMs,
    latDeg: launch.latDeg,
    lonDeg: launch.lonDeg,
    altMeters: launch.altMeters,
    northMps: launch.northMps,
    eastMps: launch.eastMps,
    upMps: launch.upMps,
    flown: false,
  };
}

/** Same step as `stepMissile`, without a new object. The launch record is not mutated. */
export function stepMissileInPlace(state: MissileState, target: TargetSample | null, dtS: number): void {
  if (state.flown || !(dtS > 0)) return;
  const tMs = state.tMs + dtS * 1000;
  if ((tMs - state.launch.tMs) / 1000 > state.launch.lifeS) {
    state.tMs = tMs;
    state.flown = true;
    return;
  }
  let northMps = state.northMps;
  let eastMps = state.eastMps;
  let upMps = state.upMps;
  if (target) {
    const relative = nedFrom(state, target);
    const north = relative.northM;
    const east = relative.eastM;
    const up = -relative.downM;
    const range2 = north * north + east * east + up * up;
    if (range2 > 1) {
      const vNorth = target.northMps - northMps;
      const vEast = target.eastMps - eastMps;
      const vUp = target.upMps - upMps;
      const omegaN = (east * vUp - up * vEast) / range2;
      const omegaE = (up * vNorth - north * vUp) / range2;
      const omegaU = (north * vEast - east * vNorth) / range2;
      const gain = state.launch.navGain;
      let accelN = gain * (omegaE * upMps - omegaU * eastMps);
      let accelE = gain * (omegaU * northMps - omegaN * upMps);
      let accelU = gain * (omegaN * eastMps - omegaE * northMps);
      const accel = Math.hypot(accelN, accelE, accelU);
      const cap = Math.hypot(northMps, eastMps, upMps) * state.launch.maxTurnRadPerSec;
      if (accel > cap && accel > 0) {
        const scale = cap / accel;
        accelN *= scale;
        accelE *= scale;
        accelU *= scale;
      }
      northMps += accelN * dtS;
      eastMps += accelE * dtS;
      upMps += accelU * dtS;
    }
  }
  const speed = Math.hypot(northMps, eastMps, upMps);
  const want = state.launch.speedMps;
  if (speed > 1e-6) {
    const scale = want / speed;
    northMps *= scale;
    eastMps *= scale;
    upMps *= scale;
  } else {
    northMps = want;
    eastMps = 0;
    upMps = 0;
  }
  const moved = geodeticFrom(state, { northM: northMps * dtS, eastM: eastMps * dtS, downM: -upMps * dtS });
  state.latDeg = moved.latDeg;
  state.lonDeg = moved.lonDeg;
  state.altMeters = moved.altMeters;
  state.northMps = northMps;
  state.eastMps = eastMps;
  state.upMps = upMps;
  state.tMs = tMs;
  state.flown = false;
}

export function stepMissile(state: MissileState, target: TargetSample | null, dtS: number): MissileState {
  if (state.flown || !(dtS > 0)) return state;
  const next = { ...state };
  stepMissileInPlace(next, target, dtS);
  return next;
}
