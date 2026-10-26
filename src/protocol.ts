/**
 * Wire messages for a flight session.
 *
 * A pose is a whole aircraft. A burst is a trigger pull. A launch is one
 * missile. Rounds are not positions on the wire: every peer integrates the
 * event, so a forged tracer never leaves the forger's screen.
 */

import type { Geodetic } from "./geodetic";
import { isDamageCapabilities, isDamageImplementation, isSharedSettings, isSharedSettingsPatch,
  type DamageImplementation, type SharedFlightSettings, type SharedSettingsPatch, type SharedSettingsRejection } from "./sharedSettings";

export const PROTOCOL_VERSION = 2;
export const MAX_MESSAGE_BYTES = 1100;
/** Feet per second on a pose, to meters per second. */
export const FT_TO_M = 0.3048;

export const PROTOCOL_LIMITS = {
  maxBurstCount: 40,
  maxRateHz: 200,
  maxMuzzleMps: 5000,
  maxBulletLifeS: 8,
  maxDragPerSec: 0.05,
  maxMissileSpeedMps: 5000,
  maxMissileTurnRadPerSec: 20,
  maxNavGain: 20,
  maxMissileLifeS: 180,
  maxBurstsPerPilot: 8,
  maxMissilesPerPilot: 8,
} as const;

const encoder = new TextEncoder();
const PILOT_ID = /^[A-Za-z0-9_-]{1,32}$/;
const JOIN_SECRET = /^[A-Za-z0-9_-]{43}$/;
const WEATHER_ID = /^[a-z0-9-]{1,32}$/;

export interface AircraftPose extends Geodetic {
  pilotId: string;
  seq: number;
  tMs: number;
  aircraftId: string;
  rollRad: number;
  pitchRad: number;
  headingRad: number;
  airspeedKts: number;
  northVelocityFps: number;
  eastVelocityFps: number;
  verticalSpeedFps: number;
  rollRateRadPerSec: number;
  pitchRateRadPerSec: number;
  yawRateRadPerSec: number;
  throttleNorm: number;
  gearDown: boolean;
  flapsNorm: number;
  afterburner: boolean;
  /** F-35B nozzle, 0 stowed to 1 full. Absent on aircraft that have none. */
  nozzleNorm?: number;
  /** Optional whole-aircraft health, 0–100. Missing means this peer does not report health. */
  health?: number;
  /** Required by serverless v2 sessions; optional for standalone world fixtures. */
  damageImplementation?: DamageImplementation;
  sharedSettingsRevision?: number;
}

export interface FireBurst extends Geodetic {
  shooterId: string;
  seq: number;
  tMs: number;
  count: number;
  rateHz: number;
  northMps: number;
  eastMps: number;
  upMps: number;
  /** Quadratic drag, 1/m. Zero is a vacuum arc. */
  dragPerSec: number;
  lifeS: number;
}

export interface MissileLaunch extends Geodetic {
  missileId: string;
  shooterId: string;
  seq: number;
  tMs: number;
  /** Absent when the missile is unguided. */
  targetId?: string;
  northMps: number;
  eastMps: number;
  upMps: number;
  navGain: number;
  maxTurnRadPerSec: number;
  speedMps: number;
  lifeS: number;
}

export interface MissileState {
  launch: MissileLaunch;
  tMs: number;
  latDeg: number;
  lonDeg: number;
  altMeters: number;
  northMps: number;
  eastMps: number;
  upMps: number;
  flown: boolean;
}

export interface WorldSettings {
  timeOfDayHours: number;
  weatherId: string;
}

export type SessionMessage =
  | { type: "hello"; v: number; pilotId: string; secret: string; aircraftId: string; damageImplementations: readonly DamageImplementation[] }
  | { type: "pose"; pose: AircraftPose }
  | { type: "held"; pilotId: string; tMs: number }
  | { type: "fire"; burst: FireBurst }
  | { type: "launch"; launch: MissileLaunch }
  | { type: "world"; world: WorldSettings }
  | { type: "shared-settings"; revision: number; settings: SharedFlightSettings }
  | { type: "shared-settings-ack"; revision: number }
  | { type: "shared-settings-ready"; revision: number }
  | { type: "shared-settings-request"; requestId: number; baseRevision: number; patch: SharedSettingsPatch }
  | { type: "shared-settings-result"; requestId: number; error: SharedSettingsRejection | null };

export function groundSpeedMps(pose: Pick<AircraftPose, "northVelocityFps" | "eastVelocityFps" | "verticalSpeedFps">): number {
  return Math.hypot(pose.northVelocityFps, pose.eastVelocityFps, pose.verticalSpeedFps) * FT_TO_M;
}

export function muzzleSpeedMps(body: Pick<FireBurst, "northMps" | "eastMps" | "upMps">): number {
  return Math.hypot(body.northMps, body.eastMps, body.upMps);
}

export function encodeMessage(message: SessionMessage): string | null {
  let json: string;
  try { json = JSON.stringify(message); } catch { return null; }
  if (!json || encoder.encode(json).byteLength > MAX_MESSAGE_BYTES) return null;
  return json;
}

export function parseMessage(json: string): SessionMessage | null {
  if (encoder.encode(json).byteLength > MAX_MESSAGE_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(json); } catch { return null; }
  if (!record(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "hello": return parseHello(value);
    case "pose": return isPose(value.pose) ? { type: "pose", pose: value.pose } : null;
    case "held": return isPilot(value.pilotId) && isTime(value.tMs) ? { type: "held", pilotId: value.pilotId, tMs: value.tMs } : null;
    case "fire": return isBurst(value.burst) ? { type: "fire", burst: value.burst } : null;
    case "launch": return isLaunch(value.launch) ? { type: "launch", launch: value.launch } : null;
    case "world": return isWorld(value.world) ? { type: "world", world: value.world } : null;
    case "shared-settings": return isCounter(value.revision) && isSharedSettings(value.settings)
      ? { type: "shared-settings", revision: value.revision, settings: value.settings } : null;
    case "shared-settings-ack":
    case "shared-settings-ready": return isCounter(value.revision) ? { type: value.type, revision: value.revision } : null;
    case "shared-settings-request": return isCounter(value.requestId) && isCounter(value.baseRevision) && isSharedSettingsPatch(value.patch)
      ? { type: "shared-settings-request", requestId: value.requestId, baseRevision: value.baseRevision, patch: value.patch } : null;
    case "shared-settings-result": return isCounter(value.requestId)
      && [null, "host-only", "permission-host-only", "stale", "unsupported", "not-ready"].includes(value.error as SharedSettingsRejection | null)
      ? { type: "shared-settings-result", requestId: value.requestId, error: value.error as SharedSettingsRejection | null } : null;
    default: return null;
  }
}

function parseHello(value: Record<string, unknown>): SessionMessage | null {
  if (value.v !== PROTOCOL_VERSION || !isPilot(value.pilotId) || !isAircraft(value.aircraftId)) return null;
  if (typeof value.secret !== "string" || !JOIN_SECRET.test(value.secret)) return null;
  if (!isDamageCapabilities(value.damageImplementations)) return null;
  return { type: "hello", v: PROTOCOL_VERSION, pilotId: value.pilotId, secret: value.secret, aircraftId: value.aircraftId,
    damageImplementations: [...value.damageImplementations] };
}

export function isPose(value: unknown): value is AircraftPose {
  if (!record(value)) return false;
  if (!isPilot(value.pilotId) || !isAircraft(value.aircraftId) || !isCounter(value.seq) || !isTime(value.tMs)) return false;
  if (!isGeodetic(value)) return false;
  if (!["rollRad", "pitchRad", "headingRad", "airspeedKts", "northVelocityFps", "eastVelocityFps", "verticalSpeedFps",
    "rollRateRadPerSec", "pitchRateRadPerSec", "yawRateRadPerSec"].every(key => finiteIn(value[key], -1e6, 1e6))) return false;
  if (!finiteIn(value.throttleNorm, 0, 1) || !finiteIn(value.flapsNorm, 0, 1) || typeof value.gearDown !== "boolean") return false;
  if (typeof value.afterburner !== "boolean") return false;
  if (value.nozzleNorm !== undefined && !finiteIn(value.nozzleNorm, 0, 1)) return false;
  if (value.health !== undefined && !finiteIn(value.health, 0, 100)) return false;
  if (value.damageImplementation !== undefined && !isDamageImplementation(value.damageImplementation)) return false;
  if (value.sharedSettingsRevision !== undefined && !isCounter(value.sharedSettingsRevision)) return false;
  return Math.abs(value.latDeg as number) <= 90;
}

export function isBurst(value: unknown): value is FireBurst {
  if (!record(value)) return false;
  if (!isPilot(value.shooterId) || !isCounter(value.seq) || !isTime(value.tMs) || !isGeodetic(value)) return false;
  if (!integerIn(value.count, 1, PROTOCOL_LIMITS.maxBurstCount)) return false;
  if (!finiteIn(value.rateHz, 1, PROTOCOL_LIMITS.maxRateHz)) return false;
  if (!finiteIn(value.dragPerSec, 0, PROTOCOL_LIMITS.maxDragPerSec)) return false;
  if (!finiteIn(value.lifeS, 0.05, PROTOCOL_LIMITS.maxBulletLifeS)) return false;
  if (!["northMps", "eastMps", "upMps"].every(key => finiteIn(value[key], -PROTOCOL_LIMITS.maxMuzzleMps, PROTOCOL_LIMITS.maxMuzzleMps))) return false;
  return Math.hypot(value.northMps as number, value.eastMps as number, value.upMps as number) <= PROTOCOL_LIMITS.maxMuzzleMps;
}

export function isLaunch(value: unknown): value is MissileLaunch {
  if (!record(value)) return false;
  if (!isPilot(value.missileId) || !isPilot(value.shooterId) || !isCounter(value.seq) || !isTime(value.tMs)) return false;
  if (value.targetId !== undefined && !isPilot(value.targetId)) return false;
  if (!isGeodetic(value)) return false;
  if (!finiteIn(value.navGain, 0, PROTOCOL_LIMITS.maxNavGain)) return false;
  if (!finiteIn(value.maxTurnRadPerSec, 0, PROTOCOL_LIMITS.maxMissileTurnRadPerSec)) return false;
  if (!finiteIn(value.speedMps, 0, PROTOCOL_LIMITS.maxMissileSpeedMps)) return false;
  if (!finiteIn(value.lifeS, 0.5, PROTOCOL_LIMITS.maxMissileLifeS)) return false;
  if (!["northMps", "eastMps", "upMps"].every(key => finiteIn(value[key], -PROTOCOL_LIMITS.maxMissileSpeedMps, PROTOCOL_LIMITS.maxMissileSpeedMps))) return false;
  return Math.hypot(value.northMps as number, value.eastMps as number, value.upMps as number) <= PROTOCOL_LIMITS.maxMissileSpeedMps;
}

function isWorld(value: unknown): value is WorldSettings {
  return record(value) && finiteIn(value.timeOfDayHours, 0, 24) && typeof value.weatherId === "string" && WEATHER_ID.test(value.weatherId);
}

function isGeodetic(value: Record<string, unknown>): boolean {
  return finiteIn(value.latDeg, -90, 90) && finiteIn(value.lonDeg, -180, 180) && finiteIn(value.altMeters, -500, 100_000);
}

function isPilot(value: unknown): value is string {
  return typeof value === "string" && PILOT_ID.test(value);
}

function isAircraft(value: unknown): value is string {
  return typeof value === "string" && PILOT_ID.test(value);
}

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTime(value: unknown): value is number {
  return finiteIn(value, 0, 1e15);
}

function finiteIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
