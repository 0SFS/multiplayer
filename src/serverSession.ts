import { readFlightServerUrl, readServerInvitation, serverInvitationUrl, randomToken, type ServerInvitation } from "./invitation";
import { encodeMessage, parseMessage, type AircraftPose, type CombatMessage, type RemovalReason, type SessionMessage } from "./protocol";
import type { RelaySocket } from "./serverRelay";
import { connectWebTransport, type ServerTarget } from "./serverTransport";
import { createSessionWorld } from "./sessionWorld";
import { DAMAGE_IMPLEMENTATIONS, DEFAULT_SHARED_SETTINGS, isDamageCapabilities, isSharedSettings, isSharedSettingsPatch,
  type DamageImplementation, type SharedFlightSettings, type SharedSettingsPatch, type SharedSettingsRejection } from "./sharedSettings";

export type LocalPose = Omit<AircraftPose, "pilotId" | "seq" | "tMs">;
export interface ServerSnapshot {
  status: "idle" | "starting" | "hosting" | "joining" | "connected" | "error";
  role: "host" | "guest" | null;
  message: string;
  invitationUrl: string | null;
  invitationExpiresAtMs: number | null;
  remotePilotId: string | null;
  diagnostics: { path: "relay"; iceRttMs: number | null; ordered: false; maxRetransmits: 0; bufferedAmount: number } | null;
  receiveToPresentMs: number | null;
  stale: boolean;
  held: boolean;
  sharedSettings: SharedFlightSettings;
  sharedSettingsRevision: number;
  sharedSettingsReady: boolean;
  sharedSettingsPending: boolean;
  sharedSettingsError: string | null;
}

/** One connection to a flight server. The server is the member list and relays admitted aircraft messages. */
export function createServerSession(options: {
  aircraftId(): string;
  serverUrl(): string;
  certHash?(): string | null;
  onChange?(): void;
  onPose?(): void;
  onSpawn?(pose: AircraftPose): void;
  onCombat?(message: CombatMessage): void;
  connect?: (target: ServerTarget) => RelaySocket | Promise<RelaySocket>;
  now?: () => number;
  initialSharedSettings?: SharedFlightSettings;
  supportedDamageImplementations?: readonly DamageImplementation[];
}) {
  const now = options.now ?? (() => performance.now());
  const supported = [...(options.supportedDamageImplementations ?? DAMAGE_IMPLEMENTATIONS)];
  const initialSettings = { ...(options.initialSharedSettings ?? DEFAULT_SHARED_SETTINGS) };
  if (!isDamageCapabilities(supported) || !isSharedSettings(initialSettings) || !supported.includes(initialSettings.damageImplementation)) {
    throw new Error("Unsupported initial multiplayer damage settings.");
  }
  let state: ServerSnapshot = idle(initialSettings);
  let socket: RelaySocket | null = null;
  let world = createSessionWorld();
  let pilotId = "";
  let sessionId = "";
  let pageBase = "";
  let target: ServerTarget | null = null;
  let hostId = "";
  let generation = 0;
  let sequence = 0;
  let clockOffset = 0;
  let clockReady = false;
  let sentPingAt: number | null = null;
  let lastPing = -Infinity;
  let nextPoseAt = -Infinity;
  let lastHeld: boolean | null = null;
  let lastHealth: number | undefined;
  let lastReceived: number | null = null;
  let spawned = false;
  let disposed = false;
  let settingsRequestId = 0;
  let pendingSettingsRequest: number | null = null;
  const roster = new Map<string, { aircraftId: string; host: boolean }>();
  const early = new Map<string, SessionMessage>();
  const notify = () => options.onChange?.();
  const change = (patch: Partial<ServerSnapshot>) => { state = { ...state, ...patch }; notify(); };

  function disconnect() {
    generation++;
    socket?.close("closed");
    socket = null;
    world = createSessionWorld();
    roster.clear(); early.clear();
    pilotId = ""; sessionId = ""; hostId = ""; target = null;
    sequence = 0; clockOffset = 0; clockReady = false; sentPingAt = null; lastPing = -Infinity;
    nextPoseAt = -Infinity; lastHeld = null; lastHealth = undefined; lastReceived = null; spawned = false;
    pendingSettingsRequest = null;
    const damageImplementation = state.sharedSettings.damageImplementation;
    state = idle({ damageImplementation, settingsEditors: "host" });
    notify();
  }
  function fail(message: string) { disconnect(); change({ status: "error", message }); }
  function send(message: SessionMessage): boolean {
    const encoded = encodeMessage(message);
    return Boolean(encoded && socket?.sendReliable(encoded));
  }
  function presence() {
    if (state.status === "idle" || state.status === "error") return;
    const pilots = Math.max(roster.size, 1);
    const live = clockReady && (state.role === "host" || state.sharedSettingsReady);
    change({ status: live ? "connected" : state.role === "host" ? "hosting" : "joining",
      message: pilots < 2 ? "Waiting for pilots. This invitation expires in two minutes." : `${pilots} pilots connected.`,
      remotePilotId: [...roster.keys()].find(id => id !== pilotId) ?? null });
  }
  function installSettings(settings: SharedFlightSettings, revision: number, ready: boolean) {
    lastHeld = null; nextPoseAt = -Infinity; early.clear();
    world = createSessionWorld();
    change({ sharedSettings: { ...settings }, sharedSettingsRevision: revision, sharedSettingsReady: ready, sharedSettingsError: null });
  }
  function inviteUrl(secret: string): string | null {
    if (!target || !pageBase || !sessionId) return null;
    return serverInvitationUrl(pageBase, { server: target.url, session: sessionId, secret, certHash: target.certHash });
  }
  function apply(message: SessionMessage) {
    if (message.type === "pose") {
      if (message.pose.pilotId === pilotId) return;
      if (message.pose.damageImplementation !== state.sharedSettings.damageImplementation || message.pose.sharedSettingsRevision !== state.sharedSettingsRevision) return;
      world.ingest(message);
      lastReceived = now();
      if (!spawned && state.role === "guest" && message.pose.pilotId === hostId) { spawned = true; options.onSpawn?.(message.pose); }
      options.onPose?.();
      return;
    }
    if (message.type === "held" || message.type === "fire" || message.type === "launch" || message.type === "world") {
      world.ingest(message);
      if (message.type === "fire" || message.type === "launch") options.onCombat?.(message);
      options.onPose?.();
    }
  }
  function take(message: SessionMessage) {
    if (!clockReady || !state.sharedSettingsReady) {
      const key = message.type === "pose" ? message.pose.pilotId : message.type === "held" ? message.pilotId : message.type;
      early.set(key, message);
      return;
    }
    apply(message);
  }
  function flushEarly() {
    if (!clockReady || !state.sharedSettingsReady) return;
    for (const message of early.values()) apply(message);
    early.clear();
    presence();
  }
  function onRemoved(reason: RemovalReason) {
    const text: Record<RemovalReason, string> = {
      strikes: "The flight server rejected this aircraft's reports.",
      left: "Disconnected from the flight server.",
      authority: "The flight server closed the session.",
      timeout: "Shared settings were not confirmed in time.",
    };
    fail(text[reason]);
  }
  function onMessage(message: SessionMessage) {
    if (message.type === "welcome") {
      sessionId = message.sessionId;
      hostId = message.role === "host" ? pilotId : "";
      installSettings(message.settings, message.revision, message.role === "host");
      const url = message.secret ? inviteUrl(message.secret) : null;
      change({ role: message.role, invitationUrl: url, invitationExpiresAtMs: message.role === "host" ? message.expiresAtMs : null });
      sentPingAt = now(); lastPing = sentPingAt;
      send({ type: "clock-ping", t: sentPingAt });
      presence();
      return;
    }
    if (message.type === "clock-pong" && message.t === sentPingAt) {
      const at = now();
      clockOffset = message.server - ((sentPingAt + at) / 2);
      clockReady = true;
      change({ diagnostics: { path: "relay", iceRttMs: Math.max(0, at - message.t), ordered: false, maxRetransmits: 0, bufferedAmount: 0 } });
      flushEarly();
      return;
    }
    if (message.type === "member") {
      if (message.present) roster.set(message.pilotId, { aircraftId: message.aircraftId, host: message.host });
      else { roster.delete(message.pilotId); world.forget(message.pilotId); }
      if (message.host && message.present) hostId = message.pilotId;
      if (message.pilotId === pilotId && message.host) change({ role: "host" });
      presence();
      return;
    }
    if (message.type === "invitation") {
      change({ role: "host", invitationUrl: inviteUrl(message.secret), invitationExpiresAtMs: message.expiresAtMs });
      presence();
      return;
    }
    if (message.type === "removed") {
      if (message.pilotId === pilotId) { onRemoved(message.reason); return; }
      roster.delete(message.pilotId); world.forget(message.pilotId); presence();
      return;
    }
    if (message.type === "shared-settings") {
      if (state.role === "host") { installSettings(message.settings, message.revision, true); presence(); return; }
      if (message.revision < state.sharedSettingsRevision) return;
      installSettings(message.settings, message.revision, false);
      send({ type: "shared-settings-ack", revision: message.revision });
      presence();
      return;
    }
    if (message.type === "shared-settings-ready") {
      if (message.revision !== state.sharedSettingsRevision) return;
      change({ sharedSettingsReady: true });
      flushEarly();
      return;
    }
    if (message.type === "shared-settings-request") {
      if (state.role !== "host") return;
      const error = requestError(message.patch, message.baseRevision);
      send({ type: "shared-settings-result", requestId: message.requestId, error });
      if (!error) commit(message.patch);
      return;
    }
    if (message.type === "shared-settings-result") {
      if (message.requestId !== pendingSettingsRequest) return;
      pendingSettingsRequest = null;
      change({ sharedSettingsPending: false, sharedSettingsError: message.error ? rejectionMessage(message.error) : null });
      return;
    }
    if (message.type === "reject") return;
    if (message.type === "hit") { options.onCombat?.(message); return; }
    if (message.type === "pose" || message.type === "held" || message.type === "fire" || message.type === "launch" || message.type === "world") take(message);
  }
  function requestError(patch: SharedSettingsPatch, baseRevision: number): SharedSettingsRejection | null {
    if (!state.sharedSettingsReady) return "not-ready";
    if (patch.settingsEditors !== undefined) return "permission-host-only";
    if (state.sharedSettings.settingsEditors !== "everyone") return "host-only";
    if (baseRevision !== state.sharedSettingsRevision) return "stale";
    const settings = { ...state.sharedSettings, ...patch };
    if (!supported.includes(settings.damageImplementation)) return "unsupported";
    return null;
  }
  function commit(patch: SharedSettingsPatch) {
    const settings = { ...state.sharedSettings, ...patch };
    if (settings.damageImplementation === state.sharedSettings.damageImplementation && settings.settingsEditors === state.sharedSettings.settingsEditors) return;
    if (state.sharedSettingsRevision === Number.MAX_SAFE_INTEGER) return;
    const others = [...roster.keys()].some(id => id !== pilotId);
    installSettings(settings, state.sharedSettingsRevision + 1, !others);
    send({ type: "shared-settings", revision: state.sharedSettingsRevision, settings: state.sharedSettings });
    if (others) presence();
  }
  function bind(link: RelaySocket, epoch: number) {
    socket = link;
    link.onReliable(encoded => { if (epoch === generation) { const message = parseMessage(encoded); if (message) onMessage(message); } });
    link.onDatagram(encoded => { if (epoch !== generation) return; const message = parseMessage(encoded); if (message) onMessage(message); });
    link.onClose(reason => {
      if (epoch !== generation || state.status === "idle") return;
      const text: Record<string, string> = {
        full: "This flight is full.",
        expired: "That invitation has expired. Ask for a new one.",
        unsupported: "This flight's damage implementation is not available here.",
        timeout: "The flight server did not answer.",
        invalid: "The invitation is invalid.",
        duplicate: "This pilot is already in the flight.",
      };
      fail(text[reason] ?? "Disconnected from the flight server.");
    });
  }
  async function open(role: "host" | "guest", next: ServerTarget): Promise<number> {
    if (disposed) throw new Error("Multiplayer has closed.");
    disconnect();
    pilotId = randomToken(12);
    target = next;
    const epoch = generation;
    change({ role, status: role === "host" ? "starting" : "joining", sharedSettingsReady: role === "host", message: "Connecting to the flight server…" });
    let link: RelaySocket;
    try { link = await (options.connect ?? connectWebTransport)(next); }
    catch { if (epoch === generation) fail("The flight server is unavailable."); throw new Error("The flight server is unavailable."); }
    if (epoch !== generation) { link.close("closed"); throw new Error("Multiplayer connection cancelled."); }
    bind(link, epoch);
    return epoch;
  }
  return {
    replaceIdleSettings(settings: SharedFlightSettings) {
      if (disposed) throw new Error("Multiplayer has closed.");
      if (state.status !== "idle" && state.status !== "error") throw new Error("Disconnect before replacing shared settings.");
      if (!isSharedSettings(settings) || !supported.includes(settings.damageImplementation)) throw new Error("Unsupported shared settings.");
      change({ status: "idle", role: null, message: "Multiplayer is off.", sharedSettings: { ...settings }, sharedSettingsRevision: 0,
        sharedSettingsReady: true, sharedSettingsPending: false, sharedSettingsError: null });
    },
    setSharedSettings(patch: SharedSettingsPatch) {
      if (disposed) throw new Error("Multiplayer has closed.");
      if (!isSharedSettingsPatch(patch)) throw new Error("Unsupported shared settings.");
      if (state.sharedSettingsPending) throw new Error("Waiting for the host to decide the previous change.");
      if (state.role === "guest") {
        const error = requestError(patch, state.sharedSettingsRevision);
        if (error) throw new Error(rejectionMessage(error));
        if (!socket || state.status !== "connected") throw new Error(rejectionMessage("not-ready"));
        const requestId = ++settingsRequestId;
        pendingSettingsRequest = requestId;
        change({ sharedSettingsPending: true, sharedSettingsError: null });
        send({ type: "shared-settings-request", requestId, baseRevision: state.sharedSettingsRevision, patch });
        return;
      }
      if (state.role !== "host") {
        if (patch.settingsEditors !== undefined) throw new Error("Host a flight before changing multiplayer permissions.");
        const settings = { ...state.sharedSettings, ...patch };
        if (!supported.includes(settings.damageImplementation)) throw new Error(rejectionMessage("unsupported"));
        change({ sharedSettings: settings, sharedSettingsError: null });
        return;
      }
      if (!state.sharedSettingsReady || state.status !== "connected") throw new Error(rejectionMessage("not-ready"));
      const settings = { ...state.sharedSettings, ...patch };
      if (!supported.includes(settings.damageImplementation)) throw new Error(rejectionMessage("unsupported"));
      commit(patch);
    },
    async host(base: string) {
      pageBase = base;
      const url = readFlightServerUrl(options.serverUrl());
      if (!url) throw new Error("Enter an https flight server address.");
      const certHash = options.certHash?.() || null;
      if (certHash && !/^[A-Za-z0-9_-]{43}$/.test(certHash)) throw new Error("The certificate hash should be 43 characters.");
      const epoch = await open("host", { url, certHash });
      send({ type: "open-flight", v: 2, pilotId, aircraftId: options.aircraftId(), damageImplementations: supported, settings: state.sharedSettings });
      await waitFor(epoch, () => state.role === "host" && state.invitationUrl !== null);
      return state.invitationUrl ?? "";
    },
    invite(base: string) {
      if (state.role !== "host" || !socket) throw new Error("Start a flight before creating an invitation.");
      pageBase = base;
      send({ type: "renew" });
    },
    async join(input: ServerInvitation | string) {
      const invitation = typeof input === "string" ? readServerInvitation(input) : input;
      if (!invitation) throw new Error("Paste a valid multiplayer invitation link.");
      const epoch = await open("guest", { url: invitation.server, certHash: invitation.certHash });
      send({ type: "hello", v: 2, pilotId, secret: invitation.secret, aircraftId: options.aircraftId(),
        damageImplementations: supported, sessionId: invitation.session });
      await waitFor(epoch, () => state.role === "guest" && (state.status === "joining" || state.status === "connected" || state.status === "error"));
      if (state.status === "error") throw new Error(state.message);
    },
    update(local: LocalPose, held: boolean) {
      if (!socket || state.status !== "connected" || !state.sharedSettingsReady || !clockReady) return;
      const time = now();
      if (time - lastPing >= 1000) { lastPing = time; sentPingAt = time; send({ type: "clock-ping", t: time }); }
      if (lastHeld !== held || (held && local.health !== lastHealth) || (!held && time >= nextPoseAt)) {
        const message: SessionMessage = { type: "pose", pose: { ...local, pilotId, seq: sequence, tMs: time + clockOffset,
          damageImplementation: state.sharedSettings.damageImplementation, sharedSettingsRevision: state.sharedSettingsRevision } };
        const encoded = encodeMessage(message);
        if (!encoded || !parseMessage(encoded)) return;
        const sent = held ? send(message) && send({ type: "held", pilotId, tMs: message.pose.tMs }) : Boolean(socket.sendDatagram(encoded));
        if (!sent) return;
        sequence++;
        const period = 1000 / 30;
        if (!Number.isFinite(nextPoseAt) || lastHeld !== held) nextPoseAt = time + period;
        else nextPoseAt += (Math.floor((time - nextPoseAt) / period) + 1) * period;
        lastHeld = held; lastHealth = local.health;
      } else if (held && time >= nextPoseAt) {
        if (!send({ type: "held", pilotId, tMs: time + clockOffset })) return;
        nextPoseAt = time + 250;
      }
    },
    publishCombat(message: CombatMessage) {
      if (!socket || state.status !== "connected" || !state.sharedSettingsReady || !clockReady) return false;
      return send(message);
    },
    nowMs() { return now() + clockOffset; },
    selfId() { return pilotId; },
    remotePoses() { return world.latestPoses(); },
    render() {
      const view = world.render(now() + clockOffset);
      state.stale = view.aircraft.some(item => item.stale);
      state.held = view.aircraft.some(item => item.held);
      state.receiveToPresentMs = lastReceived === null ? null : Math.max(0, now() - lastReceived);
      return view;
    },
    snapshot: () => ({ ...state, sharedSettings: { ...state.sharedSettings } }),
    disconnect,
    dispose() { disconnect(); disposed = true; },
  };

  function waitFor(epoch: number, ready: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      let spins = 0;
      const step = () => {
        if (state.status === "error") { reject(new Error(state.message)); return; }
        if (epoch !== generation) { reject(new Error("Multiplayer connection cancelled.")); return; }
        if (ready()) { resolve(); return; }
        if (++spins > 40) { fail("The flight server did not answer."); reject(new Error(state.message)); return; }
        setTimeout(step, 0);
      };
      setTimeout(step, 0);
    });
  }
}

function idle(settings: SharedFlightSettings): ServerSnapshot {
  return { status: "idle", role: null, message: "Multiplayer is off.", invitationUrl: null, invitationExpiresAtMs: null,
    remotePilotId: null, diagnostics: null, receiveToPresentMs: null, stale: false, held: false,
    sharedSettings: settings, sharedSettingsRevision: 0, sharedSettingsReady: true, sharedSettingsPending: false, sharedSettingsError: null };
}

function rejectionMessage(reason: SharedSettingsRejection): string {
  switch (reason) {
    case "host-only": return "Only the host can change shared settings.";
    case "permission-host-only": return "Only the host can change who may edit shared settings.";
    case "stale": return "Shared settings changed. Try again with the current settings.";
    case "unsupported": return "That damage implementation is not supported by every pilot.";
    case "not-ready": return "Waiting for every pilot to confirm the shared settings.";
  }
}

export type ServerSession = ReturnType<typeof createServerSession>;
