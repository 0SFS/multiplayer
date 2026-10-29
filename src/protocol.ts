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
const SESSION_ID = /^[A-Za-z0-9_-]{16,32}$/;
const REPORT_CODE = /^[a-z0-9-]{1,32}$/;
const WEATHER_ID = /^[a-z0-9-]{1,32}$/;
/** Authenticated pilots on one flight server, including the host. */
export const SERVER_CAPACITY = 16;

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
  /**
   * 80% cone radius about the burst velocity, radians. Both peers derive the
   * same per-round offsets from `coneSeed`, so the wire still carries one velocity.
   */
  coneRad?: number;
  coneSeed?: number;
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

/** One accepted hit. The shooter decides it; the target applies it once. */
export interface WeaponHit {
  hitId: string;
  shooterId: string;
  targetId: string;
  seq: number;
  tMs: number;
  /** Whole-aircraft health points, 1–100. */
  points: number;
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

export type RemovalReason = "strikes" | "left" | "authority" | "timeout";

export type SessionMessage =
  | { type: "hello"; v: number; pilotId: string; secret: string; aircraftId: string; damageImplementations: readonly DamageImplementation[]; sessionId?: string }
  | { type: "open-flight"; v: number; pilotId: string; aircraftId: string; damageImplementations: readonly DamageImplementation[]; settings: SharedFlightSettings }
  | { type: "welcome"; role: "host" | "guest"; sessionId: string; secret?: string; expiresAtMs: number; serverTimeMs: number; revision: number; settings: SharedFlightSettings }
  | { type: "member"; pilotId: string; aircraftId: string; host: boolean; present: boolean }
  | { type: "invitation"; secret: string; expiresAtMs: number }
  | { type: "renew" }
  | { type: "clock-ping"; t: number }
  | { type: "clock-pong"; t: number; server: number }
  | { type: "reject"; code: string; seq: number }
  | { type: "removed"; pilotId: string; reason: RemovalReason }
  | { type: "pose"; pose: AircraftPose }
  | { type: "held"; pilotId: string; tMs: number }
  | { type: "fire"; burst: FireBurst }
  | { type: "launch"; launch: MissileLaunch }
  | { type: "hit"; hit: WeaponHit }
  | { type: "world"; world: WorldSettings }
  | { type: "shared-settings"; revision: number; settings: SharedFlightSettings }
  | { type: "shared-settings-ack"; revision: number }
  | { type: "shared-settings-ready"; revision: number }
  | { type: "shared-settings-request"; requestId: number; baseRevision: number; patch: SharedSettingsPatch }
  | { type: "shared-settings-result"; requestId: number; error: SharedSettingsRejection | null };

export type CombatMessage = Extract<SessionMessage, { type: "fire" | "launch" | "hit" }>;

export function groundSpeedMps(pose: Pick<AircraftPose, "northVelocityFps" | "eastVelocityFps" | "verticalSpeedFps">): number {
  return Math.hypot(pose.northVelocityFps, pose.eastVelocityFps, pose.verticalSpeedFps) * FT_TO_M;
}

export function muzzleSpeedMps(body: Pick<FireBurst, "northMps" | "eastMps" | "upMps">): number {
  return Math.hypot(body.northMps, body.eastMps, body.upMps);
}

/** Muzzle velocity relative to the shooter. An airborne gun adds the aircraft's ground speed. */
export function relativeMuzzleMps(
  burst: Pick<FireBurst, "northMps" | "eastMps" | "upMps">,
  shooter: Pick<AircraftPose, "northVelocityFps" | "eastVelocityFps" | "verticalSpeedFps">,
): number {
  return Math.hypot(
    burst.northMps - shooter.northVelocityFps * FT_TO_M,
    burst.eastMps - shooter.eastVelocityFps * FT_TO_M,
    burst.upMps - shooter.verticalSpeedFps * FT_TO_M,
  );
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
    case "open-flight": return parseOpenFlight(value);
    case "welcome": return parseWelcome(value);
    case "member": return isPilot(value.pilotId) && isAircraft(value.aircraftId) && typeof value.host === "boolean" && typeof value.present === "boolean"
      ? { type: "member", pilotId: value.pilotId, aircraftId: value.aircraftId, host: value.host, present: value.present } : null;
    case "invitation": return isSecret(value.secret) && isTime(value.expiresAtMs) ? { type: "invitation", secret: value.secret, expiresAtMs: value.expiresAtMs } : null;
    case "renew": return { type: "renew" };
    case "clock-ping": return isTime(value.t) ? { type: "clock-ping", t: value.t } : null;
    case "clock-pong": return isTime(value.t) && isTime(value.server) ? { type: "clock-pong", t: value.t, server: value.server } : null;
    case "reject": return typeof value.code === "string" && REPORT_CODE.test(value.code) && isCounter(value.seq) ? { type: "reject", code: value.code, seq: value.seq } : null;
    case "removed": return isPilot(value.pilotId) && isRemoval(value.reason) ? { type: "removed", pilotId: value.pilotId, reason: value.reason } : null;
    case "pose": return isPose(value.pose) ? { type: "pose", pose: value.pose } : null;
    case "held": return isPilot(value.pilotId) && isTime(value.tMs) ? { type: "held", pilotId: value.pilotId, tMs: value.tMs } : null;
    case "fire": return isBurst(value.burst) ? { type: "fire", burst: value.burst } : null;
    case "launch": return isLaunch(value.launch) ? { type: "launch", launch: value.launch } : null;
    case "hit": return isHit(value.hit) ? { type: "hit", hit: value.hit } : null;
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
  if (value.sessionId !== undefined && !isSession(value.sessionId)) return null;
  return { type: "hello", v: PROTOCOL_VERSION, pilotId: value.pilotId, secret: value.secret, aircraftId: value.aircraftId,
    damageImplementations: [...value.damageImplementations], ...(isSession(value.sessionId) ? { sessionId: value.sessionId } : {}) };
}

function parseOpenFlight(value: Record<string, unknown>): SessionMessage | null {
  if (value.v !== PROTOCOL_VERSION || !isPilot(value.pilotId) || !isAircraft(value.aircraftId)) return null;
  if (!isDamageCapabilities(value.damageImplementations) || !isSharedSettings(value.settings)) return null;
  if (!value.damageImplementations.includes(value.settings.damageImplementation)) return null;
  return { type: "open-flight", v: PROTOCOL_VERSION, pilotId: value.pilotId, aircraftId: value.aircraftId,
    damageImplementations: [...value.damageImplementations], settings: { ...value.settings } };
}

function parseWelcome(value: Record<string, unknown>): SessionMessage | null {
  if ((value.role !== "host" && value.role !== "guest") || !isSession(value.sessionId)) return null;
  if (!isTime(value.expiresAtMs) || !isTime(value.serverTimeMs) || !isCounter(value.revision) || !isSharedSettings(value.settings)) return null;
  if (value.role === "guest" && value.secret !== undefined) return null;
  if (value.role === "host" && !isSecret(value.secret)) return null;
  return { type: "welcome", role: value.role, sessionId: value.sessionId, expiresAtMs: value.expiresAtMs, serverTimeMs: value.serverTimeMs,
    revision: value.revision, settings: { ...value.settings }, ...(value.role === "host" && isSecret(value.secret) ? { secret: value.secret } : {}) };
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
  if (value.coneRad !== undefined && !finiteIn(value.coneRad, 0, 0.02)) return false;
  if (value.coneSeed !== undefined && !isCounter(value.coneSeed)) return false;
  if (!["northMps", "eastMps", "upMps"].every(key => finiteIn(value[key], -PROTOCOL_LIMITS.maxMuzzleMps, PROTOCOL_LIMITS.maxMuzzleMps))) return false;
  return Math.hypot(value.northMps as number, value.eastMps as number, value.upMps as number) <= PROTOCOL_LIMITS.maxMuzzleMps;
}

export function isHit(value: unknown): value is WeaponHit {
  if (!record(value)) return false;
  if (!isPilot(value.hitId) || !isPilot(value.shooterId) || !isPilot(value.targetId)) return false;
  if (!isCounter(value.seq) || !isTime(value.tMs)) return false;
  return integerIn(value.points, 1, 100);
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

function isRemoval(value: unknown): value is RemovalReason {
  return value === "strikes" || value === "left" || value === "authority" || value === "timeout";
}

function isSecret(value: unknown): value is string {
  return typeof value === "string" && JOIN_SECRET.test(value);
}

function isSession(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
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
