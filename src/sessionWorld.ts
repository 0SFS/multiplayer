/**
 * One session's replicated world, with no socket under it.
 *
 * The transport delivers a message. This keeps the newest pose, integrates
 * bursts and launches on the shared step, and returns what to draw.
 */

import { BALLISTIC_STEP_S, roundGeodetic, roundsFromBurst, stepRoundInPlace, type RoundState } from "./ballistics";
import { missileFromLaunch, stepMissileInPlace, type TargetSample } from "./guidance";
import { showPose, type ShownPose } from "./posePlayout";
import {
  FT_TO_M, PROTOCOL_LIMITS, type AircraftPose, type FireBurst, type MissileLaunch, type MissileState,
  type SessionMessage, type WorldSettings,
} from "./protocol";

export interface DrawnRound {
  id: string;
  shooterId: string;
  seq: number;
  latDeg: number;
  lonDeg: number;
  altMeters: number;
  northMps: number;
  eastMps: number;
  upMps: number;
}

export interface SessionView {
  aircraft: ShownPose[];
  rounds: DrawnRound[];
  missiles: MissileState[];
  world: WorldSettings | null;
}

interface PilotSlot {
  pose: AircraftPose;
  history: AircraftPose[];
  held: boolean;
}

interface LiveRound {
  state: RoundState;
  steppedToMs: number;
}

interface MissileCheckpoint {
  tMs: number;
  state: MissileState;
}

interface LiveMissile {
  state: MissileState;
  steppedToMs: number;
  /** Newest target sequence the integral was built from. A newer pose rebuilds from the last checkpoint. */
  guidedOnSeq: number;
  checkpoints: MissileCheckpoint[];
}

export function createSessionWorld() {
  const pilots = new Map<string, PilotSlot>();
  const bursts = new Map<string, FireBurst[]>();
  const rounds = new Map<string, LiveRound>();
  const missiles = new Map<string, LiveMissile>();
  let world: WorldSettings | null = null;

  function ingest(message: SessionMessage): void {
    switch (message.type) {
      case "hello":
        return;
      case "world":
        world = message.world;
        return;
      case "pose":
        takePose(message.pose);
        return;
      case "held": {
        const slot = pilots.get(message.pilotId);
        if (slot && message.tMs >= slot.pose.tMs) slot.held = true;
        return;
      }
      case "fire":
        takeBurst(message.burst);
        return;
      case "launch":
        takeLaunch(message.launch);
        return;
      default:
        return;
    }
  }

  function takePose(pose: AircraftPose): void {
    const slot = pilots.get(pose.pilotId);
    if (slot && pose.seq <= slot.pose.seq) return;
    const history = slot?.history ?? [];
    history.push(pose);
    history.sort((a, b) => a.tMs - b.tMs);
    const horizon = pose.tMs - 8_000;
    pilots.set(pose.pilotId, {
      pose,
      held: false,
      history: history.filter(item => item.tMs >= horizon).slice(-240),
    });
  }

  function takeBurst(burst: FireBurst): void {
    const list = bursts.get(burst.shooterId) ?? [];
    if (list.some(item => item.seq === burst.seq)) return;
    list.push(burst);
    list.sort((a, b) => a.seq - b.seq);
    while (list.length > PROTOCOL_LIMITS.maxBurstsPerPilot) {
      const dropped = list.shift();
      if (dropped) dropBurstRounds(dropped);
    }
    bursts.set(burst.shooterId, list);
    for (const round of roundsFromBurst(burst)) {
      rounds.set(round.id, { state: round, steppedToMs: round.birthMs });
    }
  }

  function dropBurstRounds(burst: FireBurst): void {
    for (const round of roundsFromBurst(burst)) rounds.delete(round.id);
  }

  function takeLaunch(launch: MissileLaunch): void {
    const owned = [...missiles.values()].filter(item => item.state.launch.shooterId === launch.shooterId);
    if (owned.some(item => item.state.launch.seq === launch.seq)) return;
    if (owned.length >= PROTOCOL_LIMITS.maxMissilesPerPilot) {
      const oldest = owned.reduce((best, item) => item.state.launch.seq < best.state.launch.seq ? item : best);
      missiles.delete(oldest.state.launch.missileId);
    }
    const state = missileFromLaunch(launch);
    missiles.set(launch.missileId, {
      state,
      steppedToMs: launch.tMs,
      guidedOnSeq: guideSeq(launch.targetId),
      checkpoints: [{ tMs: launch.tMs, state: { ...state } }],
    });
  }

  function guideSeq(targetId: string | undefined): number {
    return targetId ? pilots.get(targetId)?.pose.seq ?? 0 : 0;
  }

  function poseAt(pilotId: string, tMs: number): AircraftPose | null {
    const history = pilots.get(pilotId)?.history;
    if (!history) return null;
    let found: AircraftPose | null = null;
    for (const pose of history) {
      if (pose.tMs <= tMs) found = pose;
      else break;
    }
    return found;
  }

  function targetAt(pilotId: string | undefined, tMs: number): TargetSample | null {
    if (!pilotId) return null;
    const pose = poseAt(pilotId, tMs);
    if (!pose) return null;
    return {
      tMs: pose.tMs,
      latDeg: pose.latDeg,
      lonDeg: pose.lonDeg,
      altMeters: pose.altMeters,
      northMps: pose.northVelocityFps * FT_TO_M,
      eastMps: pose.eastVelocityFps * FT_TO_M,
      upMps: pose.verticalSpeedFps * FT_TO_M,
    };
  }

  function copyMissile(state: MissileState): MissileState {
    return { ...state, launch: state.launch };
  }

  function rewindMissile(live: LiveMissile, poseTime: number): void {
    let resume = -1;
    for (let i = live.checkpoints.length - 1; i >= 0; i--) {
      if (live.checkpoints[i].tMs <= poseTime) { resume = i; break; }
    }
    if (resume >= 0) {
      live.state = copyMissile(live.checkpoints[resume].state);
      live.steppedToMs = live.checkpoints[resume].tMs;
      live.checkpoints.length = resume + 1;
      return;
    }
    live.state = missileFromLaunch(live.state.launch);
    live.steppedToMs = live.state.launch.tMs;
    live.checkpoints.length = 0;
  }

  function advance(nowMs: number): void {
    const stepMs = BALLISTIC_STEP_S * 1000;
    const finished: string[] = [];
    for (const [id, live] of rounds) {
      while (live.steppedToMs + stepMs <= nowMs && !live.state.done) {
        stepRoundInPlace(live.state, BALLISTIC_STEP_S);
        live.steppedToMs += stepMs;
      }
      if (live.state.done) finished.push(id);
    }
    for (const id of finished) rounds.delete(id);
    for (const live of missiles.values()) {
      const seq = guideSeq(live.state.launch.targetId);
      if (seq !== live.guidedOnSeq) {
        // A pose that arrives after we have stepped past it changes the integral.
        // Replay from the last checkpoint at or before that pose, not from the rail.
        const poseTime = live.state.launch.targetId ? pilots.get(live.state.launch.targetId)?.pose.tMs ?? live.state.launch.tMs : live.state.launch.tMs;
        rewindMissile(live, poseTime);
        live.guidedOnSeq = seq;
      }
      while (live.steppedToMs + stepMs <= nowMs && !live.state.flown) {
        stepMissileInPlace(live.state, targetAt(live.state.launch.targetId, live.steppedToMs), BALLISTIC_STEP_S);
        live.steppedToMs += stepMs;
        const previous = live.checkpoints[live.checkpoints.length - 1];
        if (!previous || live.steppedToMs - previous.tMs >= 250) {
          live.checkpoints.push({ tMs: live.steppedToMs, state: copyMissile(live.state) });
          if (live.checkpoints.length > 160) live.checkpoints.shift();
        }
      }
    }
  }

  function render(nowMs: number): SessionView {
    advance(nowMs);
    const aircraft = [...pilots.values()].map(slot => showPose(slot.pose, nowMs, slot.held));
    const drawn: DrawnRound[] = [];
    for (const live of rounds.values()) {
      if (live.state.done || nowMs < live.state.birthMs) continue;
      const place = roundGeodetic(live.state);
      drawn.push({
        id: live.state.id, shooterId: live.state.shooterId, seq: live.state.seq, ...place,
        northMps: live.state.northMps, eastMps: live.state.eastMps, upMps: live.state.upMps,
      });
    }
    return {
      aircraft,
      rounds: drawn,
      missiles: [...missiles.values()].map(item => item.state).filter(item => !item.flown),
      world,
    };
  }

  function forget(pilotId: string): void {
    pilots.delete(pilotId);
  }

  function dismiss(id: string): void {
    rounds.delete(id);
    missiles.delete(id);
  }

  function clearShots(): void {
    bursts.clear();
    rounds.clear();
    missiles.clear();
  }

  function latestPoses(): { pose: AircraftPose; held: boolean }[] {
    return [...pilots.values()].map(slot => ({ pose: slot.pose, held: slot.held }));
  }

  return { ingest, render, forget, dismiss, clearShots, latestPoses };
}

export type SessionWorld = ReturnType<typeof createSessionWorld>;
