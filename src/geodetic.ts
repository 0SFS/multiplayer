/**
 * Local spherical offsets for snapshots and rounds.
 *
 * A bullet or a missile travels a few kilometers, and a cheat check only has
 * to tell a hop from a teleport. This frame is that shared arithmetic. The
 * globe keeps its own geodesy for terrain.
 */

export const EARTH_RADIUS_M = 6_378_137;
const DEG = Math.PI / 180;

export interface Geodetic {
  latDeg: number;
  lonDeg: number;
  altMeters: number;
}

export interface Ned {
  northM: number;
  eastM: number;
  /** Positive down, so altitude loss is positive. */
  downM: number;
}

export function nedFrom(origin: Geodetic, point: Geodetic): Ned {
  const lat0 = origin.latDeg * DEG;
  return {
    northM: (point.latDeg - origin.latDeg) * DEG * EARTH_RADIUS_M,
    eastM: (point.lonDeg - origin.lonDeg) * DEG * EARTH_RADIUS_M * Math.cos(lat0),
    downM: origin.altMeters - point.altMeters,
  };
}

export function geodeticFrom(origin: Geodetic, ned: Ned): Geodetic {
  const lat0 = origin.latDeg * DEG;
  const latDeg = origin.latDeg + (ned.northM / EARTH_RADIUS_M) / DEG;
  const cos = Math.cos(lat0);
  let lonDeg = origin.lonDeg;
  if (Math.abs(cos) >= 1e-6) lonDeg += (ned.eastM / (EARTH_RADIUS_M * cos)) / DEG;
  if (lonDeg > 180) lonDeg -= 360;
  if (lonDeg < -180) lonDeg += 360;
  return { latDeg, lonDeg, altMeters: origin.altMeters - ned.downM };
}

export function distanceM(a: Geodetic, b: Geodetic): number {
  const ned = nedFrom(a, b);
  return Math.hypot(ned.northM, ned.eastM, ned.downM);
}
