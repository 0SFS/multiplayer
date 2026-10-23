/**
 * Draw a remote aircraft from the newest pose.
 *
 * The lead is the one-way delay the caller estimates, clamped. Past the stale
 * window the aircraft holds that lead instead of guessing a longer arc.
 */

import { geodeticFrom } from "./geodetic";
import { FT_TO_M, type AircraftPose } from "./protocol";

export const POSE_EXTRAPOLATE_MAX_MS = 100;
export const POSE_STALE_MS = 250;

export interface ShownPose {
  pose: AircraftPose;
  stale: boolean;
  held: boolean;
  leadMs: number;
}

export function showPose(latest: AircraftPose, nowMs: number, held = false): ShownPose {
  if (held) return { pose: latest, stale: false, held: true, leadMs: 0 };
  const gap = nowMs - latest.tMs;
  if (!(gap > 0)) return { pose: latest, stale: false, held: false, leadMs: 0 };
  const leadMs = Math.min(gap, POSE_EXTRAPOLATE_MAX_MS);
  return {
    pose: advancePose(latest, leadMs / 1000),
    stale: gap > POSE_STALE_MS,
    held: false,
    leadMs,
  };
}

export function advancePose(pose: AircraftPose, dtS: number): AircraftPose {
  if (!(dtS > 0)) return pose;
  const moved = geodeticFrom(pose, {
    northM: pose.northVelocityFps * FT_TO_M * dtS,
    eastM: pose.eastVelocityFps * FT_TO_M * dtS,
    downM: -pose.verticalSpeedFps * FT_TO_M * dtS,
  });
  return { ...pose, ...moved, ...advanceAttitude(pose, dtS), tMs: pose.tMs + dtS * 1000 };
}

function advanceAttitude(pose: AircraftPose, dtS: number): Pick<AircraftPose, "rollRad" | "pitchRad" | "headingRad"> {
  const cosPitch = Math.cos(pose.pitchRad);
  if (Math.abs(cosPitch) < 0.05) {
    return {
      rollRad: pose.rollRad + pose.rollRateRadPerSec * dtS,
      pitchRad: pose.pitchRad + pose.pitchRateRadPerSec * dtS,
      headingRad: pose.headingRad + pose.yawRateRadPerSec * dtS,
    };
  }
  const sinRoll = Math.sin(pose.rollRad);
  const cosRoll = Math.cos(pose.rollRad);
  const q = pose.pitchRateRadPerSec;
  const r = pose.yawRateRadPerSec;
  const yawFromBody = q * sinRoll + r * cosRoll;
  return {
    rollRad: pose.rollRad + (pose.rollRateRadPerSec + yawFromBody * Math.tan(pose.pitchRad)) * dtS,
    pitchRad: pose.pitchRad + (q * cosRoll - r * sinRoll) * dtS,
    headingRad: pose.headingRad + (yawFromBody / cosPitch) * dtS,
  };
}
