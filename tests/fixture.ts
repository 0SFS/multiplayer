import type { AircraftPose, FireBurst, MissileLaunch } from "../src/protocol";

export function pose(over: Partial<AircraftPose> = {}): AircraftPose {
  return {
    pilotId: "a",
    seq: 1,
    tMs: 1_000,
    aircraftId: "f-35b",
    latDeg: 45,
    lonDeg: -93,
    altMeters: 3_000,
    rollRad: 0,
    pitchRad: 0,
    headingRad: 0,
    airspeedKts: 300,
    northVelocityFps: 500,
    eastVelocityFps: 0,
    verticalSpeedFps: 0,
    rollRateRadPerSec: 0,
    pitchRateRadPerSec: 0,
    yawRateRadPerSec: 0,
    throttleNorm: 0.7,
    gearDown: false,
    flapsNorm: 0,
    afterburner: false,
    ...over,
  };
}

export function burst(over: Partial<FireBurst> = {}): FireBurst {
  return {
    shooterId: "a",
    seq: 1,
    tMs: 1_000,
    count: 3,
    rateHz: 20,
    latDeg: 45,
    lonDeg: -93,
    altMeters: 3_000,
    northMps: 800,
    eastMps: 0,
    upMps: 0,
    dragPerSec: 0,
    lifeS: 3,
    ...over,
  };
}

export function launch(over: Partial<MissileLaunch> = {}): MissileLaunch {
  return {
    missileId: "m1",
    shooterId: "a",
    seq: 1,
    tMs: 1_000,
    targetId: "b",
    latDeg: 45,
    lonDeg: -93,
    altMeters: 3_000,
    northMps: 300,
    eastMps: 0,
    upMps: 0,
    navGain: 4,
    maxTurnRadPerSec: 1,
    speedMps: 300,
    lifeS: 20,
    ...over,
  };
}
