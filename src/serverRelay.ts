/**
 * Flight server membership and fan-out. One connection per pilot.
 *
 * Poses, bursts and launches pass through the supplied admission before
 * anyone else receives them. This module does not import the envelope:
 * the process we run passes `@0sfs/anti-cheat`'s server watcher.
 */

import { randomToken, INVITATION_LIFETIME_MS } from "./invitation";
import { encodeMessage, parseMessage, SERVER_CAPACITY, type AircraftPose, type RemovalReason, type SessionMessage } from "./protocol";
import { isDamageImplementation, type DamageImplementation, type SharedFlightSettings, type SharedSettingsRejection } from "./sharedSettings";

export interface RelayVerdict { accepted: boolean; dropped: boolean; code: string | null }
export interface RelayAdmission {
  pose(pose: AircraftPose): RelayVerdict;
  burst(message: Extract<SessionMessage, { type: "fire" }>["burst"]): RelayVerdict;
  launch(message: Extract<SessionMessage, { type: "launch" }>["launch"]): RelayVerdict;
}

export interface RelaySocket {
  sendReliable(encoded: string): boolean;
  sendDatagram(encoded: string): boolean;
  close(reason?: string): void;
  onReliable(handler: (encoded: string) => void): void;
  onDatagram(handler: (encoded: string) => void): void;
  onClose(handler: (reason: string) => void): void;
}

const acceptAll: RelayAdmission = {
  pose: () => ({ accepted: true, dropped: false, code: null }),
  burst: () => ({ accepted: true, dropped: false, code: null }),
  launch: () => ({ accepted: true, dropped: false, code: null }),
};

interface Member {
  pilotId: string;
  aircraftId: string;
  capabilities: readonly DamageImplementation[];
  socket: RelaySocket;
  joinedAt: number;
  lastPose: AircraftPose | null;
}

interface Flight {
  id: string;
  secret: string;
  expiresAt: number;
  hostId: string;
  settings: SharedFlightSettings;
  revision: number;
  settled: boolean;
  acked: Set<string>;
  world: Extract<SessionMessage, { type: "world" }>["world"] | null;
  members: Map<string, Member>;
  admission: RelayAdmission;
  pendingRequest: { requestId: number; guestId: string } | null;
  settingsTimer: ReturnType<typeof setTimeout> | null;
}

export function createServerRelay(options: {
  now?: () => number;
  capacity?: number;
  admission?: () => RelayAdmission;
  invitationLifetimeMs?: number;
  helloTimeoutMs?: number;
  settingsTimeoutMs?: number;
  pendingLimit?: number;
} = {}) {
  const now = options.now ?? (() => Date.now());
  const capacity = options.capacity ?? SERVER_CAPACITY;
  const admissionFor = options.admission ?? (() => acceptAll);
  const lifetime = options.invitationLifetimeMs ?? INVITATION_LIFETIME_MS;
  const helloTimeoutMs = options.helloTimeoutMs ?? 5_000;
  const settingsTimeoutMs = options.settingsTimeoutMs ?? 5_000;
  const pendingLimit = options.pendingLimit ?? 32;
  const flights = new Map<string, Flight>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let pending = 0;
  let closed = false;

  function later(fn: () => void, delay: number) {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, delay);
    timers.add(timer);
    return timer;
  }
  function clear(timer: ReturnType<typeof setTimeout> | null) {
    if (timer === null) return;
    clearTimeout(timer);
    timers.delete(timer);
  }
  function send(member: Member, message: SessionMessage): boolean {
    const encoded = encodeMessage(message);
    return encoded !== null && member.socket.sendReliable(encoded);
  }
  function sendDatagram(member: Member, message: SessionMessage): boolean {
    const encoded = encodeMessage(message);
    return encoded !== null && member.socket.sendDatagram(encoded);
  }
  function settingsOf(settings: SharedFlightSettings): SharedFlightSettings {
    return { damageImplementation: settings.damageImplementation, settingsEditors: settings.settingsEditors };
  }
  function sameSettings(a: SharedFlightSettings, b: SharedFlightSettings): boolean {
    return a.damageImplementation === b.damageImplementation && a.settingsEditors === b.settingsEditors;
  }
  function supported(flight: Flight, implementation: DamageImplementation): boolean {
    return [...flight.members.values()].every(member => member.capabilities.includes(implementation));
  }
  function destroy(flight: Flight) {
    clear(flight.settingsTimer);
    flights.delete(flight.id);
  }
  function announce(flight: Flight, member: Member, present: boolean) {
    const message: SessionMessage = { type: "member", pilotId: member.pilotId, aircraftId: member.aircraftId, host: member.pilotId === flight.hostId && present, present };
    for (const other of flight.members.values()) send(other, message);
  }
  function settle(flight: Flight, only?: Member) {
    flight.settled = true;
    clear(flight.settingsTimer);
    flight.settingsTimer = null;
    const ready: SessionMessage = { type: "shared-settings-ready", revision: flight.revision };
    if (only) { send(only, ready); return; }
    for (const member of flight.members.values()) send(member, ready);
  }
  function catchUp(flight: Flight, guest: Member) {
    const ordered = [...flight.members.values()].filter(member => member.pilotId !== guest.pilotId && member.lastPose)
      .sort((a, b) => Number(b.pilotId === flight.hostId) - Number(a.pilotId === flight.hostId));
    for (const member of ordered) send(guest, { type: "pose", pose: member.lastPose! });
    if (flight.world) send(guest, { type: "world", world: flight.world });
  }
  function arm(flight: Flight) {
    clear(flight.settingsTimer);
    flight.settingsTimer = later(() => {
      flight.settingsTimer = null;
      if (flight.settled || !flights.has(flight.id)) return;
      for (const id of [...flight.members.keys()]) if (!flight.acked.has(id)) remove(flight, id, "timeout");
      if (flights.has(flight.id) && [...flight.members.keys()].every(id => flight.acked.has(id))) settle(flight);
    }, settingsTimeoutMs);
  }
  function publish(flight: Flight, settings: SharedFlightSettings, revision: number) {
    flight.settings = settingsOf(settings);
    flight.revision = revision;
    flight.settled = false;
    flight.acked = new Set([flight.hostId]);
    for (const member of flight.members.values()) member.lastPose = null;
    const message: SessionMessage = { type: "shared-settings", revision, settings: flight.settings };
    for (const member of flight.members.values()) if (member.pilotId !== flight.hostId) send(member, message);
    if (flight.members.size === 1) settle(flight);
    else arm(flight);
  }
  function mint(flight: Flight, host: Member) {
    flight.secret = randomToken();
    flight.expiresAt = now() + lifetime;
    send(host, { type: "invitation", secret: flight.secret, expiresAtMs: flight.expiresAt });
  }
  function remove(flight: Flight, pilotId: string, reason: RemovalReason) {
    const member = flight.members.get(pilotId);
    if (!member) return;
    flight.members.delete(pilotId);
    flight.acked.delete(pilotId);
    if (flight.pendingRequest?.guestId === pilotId) flight.pendingRequest = null;
    const note: SessionMessage = { type: "removed", pilotId, reason };
    for (const other of flight.members.values()) send(other, note);
    send(member, note);
    if (flight.members.size === 0) { destroy(flight); member.socket.close(reason); return; }
    announce(flight, member, false);
    if (pilotId === flight.hostId) {
      const next = [...flight.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      flight.hostId = next.pilotId;
      if (!flight.acked.has(next.pilotId)) flight.acked.add(next.pilotId);
      announce(flight, next, true);
      mint(flight, next);
    }
    if (!flight.settled && [...flight.members.keys()].every(id => flight.acked.has(id))) settle(flight);
    member.socket.close(reason);
  }
  function admitPose(flight: Flight, self: string, pose: AircraftPose, via: "reliable" | "datagram"): boolean {
    const member = flight.members.get(self);
    if (!member || !flight.settled || !flight.acked.has(self)) return false;
    if (pose.pilotId !== self) { remove(flight, self, "authority"); return false; }
    if (pose.damageImplementation !== flight.settings.damageImplementation || pose.sharedSettingsRevision !== flight.revision) return false;
    const verdict = flight.admission.pose(pose);
    if (!verdict.accepted) {
      send(member, { type: "reject", code: verdict.code ?? "rejected", seq: pose.seq });
      if (verdict.dropped) remove(flight, self, "strikes");
      return false;
    }
    member.lastPose = pose;
    const message: SessionMessage = { type: "pose", pose };
    for (const other of flight.members.values()) {
      if (other.pilotId === self || !flight.acked.has(other.pilotId)) continue;
      if (via === "reliable") send(other, message);
      else sendDatagram(other, message);
    }
    return true;
  }
  function onReliable(flight: Flight, self: string, message: SessionMessage) {
    const member = flight.members.get(self);
    if (!member || !flights.has(flight.id)) return;
    if (message.type === "pose") { admitPose(flight, self, message.pose, "reliable"); return; }
    if (message.type === "held") {
      if (message.pilotId !== self) { remove(flight, self, "authority"); return; }
      for (const other of flight.members.values()) if (other.pilotId !== self) send(other, message);
      return;
    }
    if (message.type === "fire" || message.type === "launch") {
      const shooter = message.type === "fire" ? message.burst.shooterId : message.launch.shooterId;
      if (shooter !== self) { remove(flight, self, "authority"); return; }
      const verdict = message.type === "fire" ? flight.admission.burst(message.burst) : flight.admission.launch(message.launch);
      if (!verdict.accepted) {
        send(member, { type: "reject", code: verdict.code ?? "rejected", seq: message.type === "fire" ? message.burst.seq : message.launch.seq });
        if (verdict.dropped) remove(flight, self, "strikes");
        return;
      }
      for (const other of flight.members.values()) if (other.pilotId !== self) send(other, message);
      return;
    }
    if (message.type === "hit") {
      if (message.hit.shooterId !== self) { remove(flight, self, "authority"); return; }
      for (const other of flight.members.values()) if (other.pilotId !== self) send(other, message);
      return;
    }
    if (message.type === "world") {
      if (self !== flight.hostId) { remove(flight, self, "authority"); return; }
      flight.world = message.world;
      for (const other of flight.members.values()) if (other.pilotId !== self) send(other, message);
      return;
    }
    if (message.type === "shared-settings") {
      if (self !== flight.hostId) { remove(flight, self, "authority"); return; }
      if (!isDamageImplementation(message.settings.damageImplementation) || !supported(flight, message.settings.damageImplementation)) {
        send(member, { type: "shared-settings", revision: flight.revision, settings: flight.settings });
        return;
      }
      if (message.revision === flight.revision && sameSettings(message.settings, flight.settings)) return;
      if (message.revision !== flight.revision + 1) {
        send(member, { type: "shared-settings", revision: flight.revision, settings: flight.settings });
        return;
      }
      publish(flight, message.settings, message.revision);
      return;
    }
    if (message.type === "shared-settings-ack") {
      if (self === flight.hostId || message.revision !== flight.revision || flight.acked.has(self)) return;
      flight.acked.add(self);
      const complete = [...flight.members.keys()].every(id => flight.acked.has(id));
      if (complete && !flight.settled) settle(flight);
      else if (flight.settled) send(member, { type: "shared-settings-ready", revision: flight.revision });
      if (flight.settled) catchUp(flight, member);
      return;
    }
    if (message.type === "shared-settings-request") {
      if (self === flight.hostId) { remove(flight, self, "authority"); return; }
      const error = guestError(flight, message);
      if (error) { send(member, { type: "shared-settings-result", requestId: message.requestId, error }); return; }
      if (flight.pendingRequest) { send(member, { type: "shared-settings-result", requestId: message.requestId, error: "not-ready" }); return; }
      flight.pendingRequest = { requestId: message.requestId, guestId: self };
      const host = flight.members.get(flight.hostId);
      if (host) send(host, message);
      return;
    }
    if (message.type === "shared-settings-result") {
      if (self !== flight.hostId || !flight.pendingRequest || message.requestId !== flight.pendingRequest.requestId) {
        if (self !== flight.hostId) remove(flight, self, "authority");
        return;
      }
      const guest = flight.members.get(flight.pendingRequest.guestId);
      flight.pendingRequest = null;
      if (guest) send(guest, message);
      return;
    }
    if (message.type === "renew") {
      if (self !== flight.hostId) { remove(flight, self, "authority"); return; }
      mint(flight, member);
      return;
    }
    if (message.type === "clock-ping") { send(member, { type: "clock-pong", t: message.t, server: now() }); return; }
  }
  function guestError(flight: Flight, message: Extract<SessionMessage, { type: "shared-settings-request" }>): SharedSettingsRejection | null {
    if (!flight.settled) return "not-ready";
    if (message.patch.settingsEditors !== undefined) return "permission-host-only";
    if (flight.settings.settingsEditors !== "everyone") return "host-only";
    if (message.baseRevision !== flight.revision) return "stale";
    const next = { ...flight.settings, ...message.patch };
    if (next.damageImplementation && !supported(flight, next.damageImplementation)) return "unsupported";
    return null;
  }
  function bind(flight: Flight, member: Member) {
    member.socket.onDatagram(encoded => {
      if (!flight.members.has(member.pilotId)) return;
      const message = parseMessage(encoded);
      if (message?.type === "pose") admitPose(flight, member.pilotId, message.pose, "datagram");
    });
    member.socket.onReliable(encoded => {
      if (!flight.members.has(member.pilotId)) return;
      const message = parseMessage(encoded);
      if (!message) { remove(flight, member.pilotId, "authority"); return; }
      onReliable(flight, member.pilotId, message);
    });
    member.socket.onClose(() => { if (flight.members.has(member.pilotId)) remove(flight, member.pilotId, "left"); });
  }
  function welcome(flight: Flight, member: Member, role: "host" | "guest") {
    const message: SessionMessage = { type: "welcome", role, sessionId: flight.id, expiresAtMs: flight.expiresAt, serverTimeMs: now(),
      revision: flight.revision, settings: flight.settings, ...(role === "host" ? { secret: flight.secret } : {}) };
    send(member, message);
    for (const other of flight.members.values()) send(member, { type: "member", pilotId: other.pilotId, aircraftId: other.aircraftId, host: other.pilotId === flight.hostId, present: true });
    if (role === "guest") {
      send(member, { type: "shared-settings", revision: flight.revision, settings: flight.settings });
      for (const other of flight.members.values()) if (other.pilotId !== member.pilotId) {
        send(other, { type: "member", pilotId: member.pilotId, aircraftId: member.aircraftId, host: false, present: true });
      }
      const pilotId = member.pilotId;
      const revision = flight.revision;
      later(() => {
        if (flights.has(flight.id) && flight.revision === revision && flight.members.has(pilotId) && !flight.acked.has(pilotId)) remove(flight, pilotId, "timeout");
      }, settingsTimeoutMs);
    }
  }
  function reject(socket: RelaySocket, reason: string) { socket.close(reason); }

  return {
    accept(socket: RelaySocket) {
      if (closed || pending >= pendingLimit) { reject(socket, "full"); return; }
      pending++;
      let authed = false;
      const timer = later(() => { if (!authed) { done(); socket.close("timeout"); } }, helloTimeoutMs);
      const done = () => { if (authed) return; authed = true; pending--; clear(timer); };
      socket.onClose(() => { if (!authed) done(); });
      socket.onReliable(encoded => {
        if (authed || closed) return;
        const message = parseMessage(encoded);
        if (message?.type === "open-flight") {
          done();
          const flight: Flight = {
            id: randomToken(16), secret: randomToken(), expiresAt: now() + lifetime, hostId: message.pilotId,
            settings: settingsOf(message.settings), revision: 0, settled: true, acked: new Set([message.pilotId]),
            world: null, members: new Map(), admission: admissionFor(), pendingRequest: null, settingsTimer: null,
          };
          const member: Member = { pilotId: message.pilotId, aircraftId: message.aircraftId, capabilities: message.damageImplementations,
            socket, joinedAt: now(), lastPose: null };
          flight.members.set(member.pilotId, member);
          flights.set(flight.id, flight);
          bind(flight, member);
          welcome(flight, member, "host");
          return;
        }
        if (message?.type === "hello" && message.sessionId) {
          const flight = flights.get(message.sessionId);
          if (!flight || !secretMatches(flight.secret, message.secret)) { done(); reject(socket, "invalid"); return; }
          if (now() >= flight.expiresAt) { done(); reject(socket, "expired"); return; }
          if (flight.members.size >= capacity) { done(); reject(socket, "full"); return; }
          if (flight.members.has(message.pilotId)) { done(); reject(socket, "duplicate"); return; }
          if (!message.damageImplementations.includes(flight.settings.damageImplementation)) { done(); reject(socket, "unsupported"); return; }
          done();
          const member: Member = { pilotId: message.pilotId, aircraftId: message.aircraftId, capabilities: message.damageImplementations,
            socket, joinedAt: now(), lastPose: null };
          flight.members.set(member.pilotId, member);
          bind(flight, member);
          welcome(flight, member, "guest");
          return;
        }
        done();
        reject(socket, "invalid");
      });
    },
    close() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const flight of [...flights.values()]) {
        const members = [...flight.members.values()];
        flight.members.clear();
        destroy(flight);
        for (const member of members) member.socket.close("closed");
      }
    },
  };
}

function secretMatches(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

export type ServerRelay = ReturnType<typeof createServerRelay>;
