import { createPeerEndpoint, type PeerEndpoint, type SessionTransport, type TransportDiagnostics } from "@0sfs/rc/peerTransport";
import { invitationUrl, randomToken, readInvitation, INVITATION_LIFETIME_MS, type Invitation } from "./invitation";
import { encodeMessage, parseMessage, PROTOCOL_VERSION, type AircraftPose, type SessionMessage } from "./protocol";
import { createSessionWorld } from "./sessionWorld";
import { DAMAGE_IMPLEMENTATIONS, DEFAULT_SHARED_SETTINGS, isDamageCapabilities, isSharedSettings, isSharedSettingsPatch,
  type DamageImplementation, type SharedFlightSettings, type SharedSettingsPatch, type SharedSettingsRejection } from "./sharedSettings";

export type LocalPose = Omit<AircraftPose, "pilotId" | "seq" | "tMs">;
export interface ServerlessSnapshot {
  status: "idle" | "starting" | "hosting" | "joining" | "connected" | "error";
  role: "host" | "guest" | null;
  message: string;
  invitationUrl: string | null;
  invitationExpiresAtMs: number | null;
  remotePilotId: string | null;
  diagnostics: TransportDiagnostics | null;
  receiveToPresentMs: number | null;
  stale: boolean;
  held: boolean;
  sharedSettings: SharedFlightSettings;
  sharedSettingsRevision: number;
  sharedSettingsReady: boolean;
  sharedSettingsPending: boolean;
  sharedSettingsError: string | null;
}

/** First browser milestone: two full simulators, one direct link, no relay or checks. */
export function createServerlessSession(options: {
  aircraftId(): string;
  onChange?(): void;
  onPose?(): void;
  onSpawn?(pose: AircraftPose): void;
  createEndpoint?: typeof createPeerEndpoint;
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
  let state: ServerlessSnapshot = {
    status: "idle", role: null, message: "Multiplayer is off.", invitationUrl: null,
    invitationExpiresAtMs: null, remotePilotId: null, diagnostics: null,
    receiveToPresentMs: null, stale: false, held: false,
    sharedSettings: initialSettings, sharedSettingsRevision: 0, sharedSettingsReady: true,
    sharedSettingsPending: false, sharedSettingsError: null,
  };
  let endpoint: PeerEndpoint | null = null;
  let active: SessionTransport | null = null;
  const pending = new Set<SessionTransport>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let world = createSessionWorld();
  let pilotId = randomToken(12);
  let peerId = "";
  let secret = "";
  let deadline = 0;
  let generation = 0;
  let sequence = 0;
  let lastSend = -Infinity;
  let nextPoseAt = -Infinity;
  let lastHeld: boolean | null = null;
  let lastHealth: number | undefined;
  let clockOffset = 0;
  let lastReceived: number | null = null;
  let disposed = false;
  let diagnosticsPending = false;
  let lastDiagnostics = -Infinity;
  let remoteDamageImplementations: readonly DamageImplementation[] = [];
  let receivedSettings = false;
  let settingsTimer: ReturnType<typeof setTimeout> | null = null;
  let settingsRequestId = 0;
  let pendingSettingsRequest: number | null = null;
  const notify = () => options.onChange?.();
  const change = (patch: Partial<ServerlessSnapshot>) => { state = { ...state, ...patch }; notify(); };
  function later(fn: () => void, delay: number) {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, delay);
    timers.add(timer);
    return timer;
  }
  function clear(timer: ReturnType<typeof setTimeout>) { clearTimeout(timer); timers.delete(timer); }
  function disconnect() {
    generation++;
    const previous = endpoint;
    endpoint = null; active = null;
    for (const timer of timers) clearTimeout(timer);
    timers.clear(); pending.clear();
    previous?.destroy();
    world = createSessionWorld();
    secret = ""; deadline = 0; lastHeld = null; lastSend = -Infinity; lastReceived = null;
    sequence = 0; clockOffset = 0; diagnosticsPending = false; lastDiagnostics = -Infinity;
    nextPoseAt = -Infinity;
    lastHealth = undefined;
    remoteDamageImplementations = []; receivedSettings = false; settingsTimer = null; pendingSettingsRequest = null;
    state = { status: "idle", role: null, message: "Multiplayer is off.", invitationUrl: null,
      invitationExpiresAtMs: null, remotePilotId: null, diagnostics: null, receiveToPresentMs: null, stale: false, held: false,
      sharedSettings: { damageImplementation: state.sharedSettings.damageImplementation, settingsEditors: "host" },
      sharedSettingsRevision: 0, sharedSettingsReady: true, sharedSettingsPending: false, sharedSettingsError: null };
    notify();
  }
  function fail(message: string) { disconnect(); change({ status: "error", message }); }
  function send(link: SessionTransport, message: unknown) {
    if (!link.sendReliable(message)) { link.fail("session-send-failed", "The multiplayer session channel is full or closed."); return false; }
    return true;
  }
  function parse(value: unknown): SessionMessage | null {
    try { return parseMessage(JSON.stringify(value)); } catch { return null; }
  }
  function installSettings(settings: SharedFlightSettings, revision: number, ready: boolean) {
    lastHeld = null; nextPoseAt = -Infinity;
    // An old pose cannot remain the displayed combat state for a new settings revision.
    world = createSessionWorld();
    change({ sharedSettings: { ...settings }, sharedSettingsRevision: revision, sharedSettingsReady: ready, sharedSettingsError: null });
  }
  function publishSettings(link: SessionTransport) {
    if (settingsTimer !== null) clear(settingsTimer);
    change({ sharedSettingsReady: false });
    settingsTimer = later(() => link.fail("settings-timeout", "The other pilot did not confirm the shared settings."), 5000);
    send(link, { type: "shared-settings", revision: state.sharedSettingsRevision, settings: state.sharedSettings });
  }
  function applySettingsPatch(patch: SharedSettingsPatch, guest: boolean, baseRevision: number): SharedSettingsRejection | null {
    if (!state.sharedSettingsReady) return "not-ready";
    if (guest && patch.settingsEditors !== undefined) return "permission-host-only";
    if (guest && state.sharedSettings.settingsEditors !== "everyone") return "host-only";
    if (baseRevision !== state.sharedSettingsRevision) return "stale";
    const settings = { ...state.sharedSettings, ...patch };
    if (!supported.includes(settings.damageImplementation)
      || (active && !remoteDamageImplementations.includes(settings.damageImplementation))) return "unsupported";
    if (settings.damageImplementation === state.sharedSettings.damageImplementation && settings.settingsEditors === state.sharedSettings.settingsEditors) {
      change({ sharedSettingsError: null }); return null;
    }
    if (state.sharedSettingsRevision === Number.MAX_SAFE_INTEGER) return "not-ready";
    installSettings(settings, state.sharedSettingsRevision + 1, !active);
    if (active) publishSettings(active);
    return null;
  }
  function attach(link: SessionTransport, invitation: Invitation | null, epoch: number) {
    if (epoch !== generation || pending.size >= 4 || active) { link.close(); return; }
    pending.add(link);
    let authenticated = false, finished = false, remoteReady = false, localReady = false;
    let remoteId = "";
    let clockReady = !invitation;
    let readySent = false;
    let spawned = false;
    let sentPingAt: number | null = null;
    let helloTimer: ReturnType<typeof setTimeout> | null = null;
    const setupTimer = later(() => link.fail("setup-timeout", "The multiplayer connection timed out. Try a new invitation."), 20_000);
    const connected = () => {
      if (!localReady || !remoteReady || !clockReady || !state.sharedSettingsReady || epoch !== generation || finished || state.status === "connected") return;
      clear(setupTimer);
      active = link; pending.delete(link);
      change({ status: "connected", message: "Two pilots connected.", remotePilotId: remoteId, invitationUrl: null, invitationExpiresAtMs: null });
      lastSend = -Infinity; lastHeld = null;
    };
    const announceReady = () => {
      if (!localReady || !clockReady || readySent) return;
      readySent = true;
      send(link, { type: "pose-ready" });
    };
    function acceptPose(message: Extract<SessionMessage, { type: "pose" }>) {
      if (!authenticated || !localReady || !remoteReady || !clockReady || !state.sharedSettingsReady || epoch !== generation || finished) return;
      if (message.pose.pilotId !== remoteId) { link.fail("invalid-pose", "Invalid aircraft snapshot."); return; }
      if (message.pose.damageImplementation !== state.sharedSettings.damageImplementation
        || message.pose.sharedSettingsRevision !== state.sharedSettingsRevision) return;
      const time = now() + clockOffset;
      if (message.pose.tMs > time + 1000 || time - message.pose.tMs > 10_000) return;
      const previous = world.render(time).aircraft[0];
      if (previous && message.pose.seq <= previous.pose.seq) return;
      world.ingest(message);
      lastReceived = now();
      if (!spawned && invitation) { spawned = true; options.onSpawn?.(message.pose); }
      options.onPose?.();
    }
    const openPose = (streamId?: number) => {
      const opened = link.openNative(streamId);
      if (streamId === undefined) send(link, { type: "pose-channel", id: link.nativeStreamId });
      void opened.then(() => {
        if (epoch !== generation || finished) return;
        localReady = true; announceReady(); connected();
      }).catch(() => { if (epoch === generation && !finished) link.fail("pose-setup-failed", "The aircraft channel could not open."); });
    };
    link.onClose(() => {
      finished = true; clear(setupTimer); if (helloTimer !== null) clear(helloTimer);
      pending.delete(link);
      if (epoch !== generation) return;
      if (active === link || invitation) fail("The other pilot disconnected. Your local flight continues; use a new invitation to reconnect.");
    });
    link.onReliable(value => {
      if (epoch !== generation || finished) return;
      if (!authenticated) {
        const hello = parse(value);
        if (hello?.type !== "hello" || hello.pilotId === pilotId ||
          hello.secret !== (invitation?.secret ?? secret) || (!invitation && (now() >= deadline || active))) {
          link.fail("invalid-hello", "The invitation is invalid, expired, or already used."); return;
        }
        authenticated = true; remoteId = hello.pilotId;
        remoteDamageImplementations = [...hello.damageImplementations];
        if (helloTimer !== null) clear(helloTimer);
        if (!invitation) {
          // Consume before sending a reply, so a second pending hello cannot race it.
          secret = ""; deadline = 0; active = link;
          change({ invitationUrl: null, invitationExpiresAtMs: null });
          if (!remoteDamageImplementations.includes(state.sharedSettings.damageImplementation)) {
            link.fail("unsupported-damage-model", "The invited pilot does not support this flight's damage implementation."); return;
          }
          send(link, { type: "hello", v: PROTOCOL_VERSION, pilotId, secret: hello.secret, aircraftId: options.aircraftId(), damageImplementations: supported });
          publishSettings(link);
          openPose();
        } else {
          sentPingAt = now();
          send(link, { type: "clock-ping", t: sentPingAt });
        }
        return;
      }
      if (!value || typeof value !== "object") { link.close(); return; }
      const control = value as Record<string, unknown>;
      if (control.type === "pose-channel" && invitation && Number.isInteger(control.id)) { openPose(control.id as number); return; }
      if (control.type === "pose-ready") { remoteReady = true; connected(); return; }
      if (control.type === "clock-ping" && !invitation && typeof control.t === "number" && Number.isFinite(control.t)) {
        send(link, { type: "clock-pong", t: control.t, host: now() }); return;
      }
      if (control.type === "clock-pong" && invitation && control.t === sentPingAt && typeof control.host === "number" && Number.isFinite(control.host)) {
        clockOffset = control.host - ((sentPingAt! + now()) / 2); clockReady = true; announceReady(); connected(); return;
      }
      const message = parse(value);
      if (message?.type === "shared-settings") {
        if (!invitation) { link.fail("settings-authority", "Only the host can publish shared settings."); return; }
        if (!supported.includes(message.settings.damageImplementation)) {
          link.fail("unsupported-damage-model", "This flight's damage implementation is not available here."); return;
        }
        if (receivedSettings && message.revision <= state.sharedSettingsRevision) return;
        receivedSettings = true;
        installSettings(message.settings, message.revision, false);
        send(link, { type: "shared-settings-ack", revision: message.revision });
        return;
      }
      if (message?.type === "shared-settings-ack") {
        if (invitation) { link.fail("settings-authority", "Invalid shared-settings acknowledgement."); return; }
        if (message.revision !== state.sharedSettingsRevision) return;
        if (settingsTimer !== null) { clear(settingsTimer); settingsTimer = null; }
        change({ sharedSettingsReady: true });
        send(link, { type: "shared-settings-ready", revision: message.revision });
        connected(); return;
      }
      if (message?.type === "shared-settings-ready") {
        if (!invitation) { link.fail("settings-authority", "Only the host can confirm shared settings."); return; }
        if (!receivedSettings || message.revision !== state.sharedSettingsRevision) return;
        change({ sharedSettingsReady: true }); connected(); return;
      }
      if (message?.type === "shared-settings-request") {
        if (invitation) { link.fail("settings-authority", "The host cannot submit a guest settings request."); return; }
        const error = applySettingsPatch(message.patch, true, message.baseRevision);
        send(link, { type: "shared-settings-result", requestId: message.requestId, error }); return;
      }
      if (message?.type === "shared-settings-result") {
        if (!invitation) { link.fail("settings-authority", "Only the host can decide a settings request."); return; }
        if (message.requestId !== pendingSettingsRequest) return;
        pendingSettingsRequest = null;
        change({ sharedSettingsPending: false, sharedSettingsError: message.error ? rejectionMessage(message.error) : null }); return;
      }
      if (message?.type === "pose") { acceptPose(message); return; }
      if (message?.type === "held" && message.pilotId === remoteId) { world.ingest(message); options.onPose?.(); return; }
      link.fail("invalid-session-message", "Invalid multiplayer session message.");
    });
    link.onNative(value => {
      if (!authenticated || !localReady || !remoteReady || !clockReady || epoch !== generation || finished) return;
      const message = parse(value);
      if (message?.type !== "pose" || message.pose.pilotId !== remoteId) { link.fail("invalid-pose", "Invalid aircraft snapshot."); return; }
      acceptPose(message);
    });
    void link.ready.then(() => {
      if (epoch !== generation || finished) return;
      helloTimer = later(() => link.fail("hello-timeout", "The invitation handshake timed out."), 5000);
      if (invitation) send(link, { type: "hello", v: PROTOCOL_VERSION, pilotId, secret: invitation.secret, aircraftId: options.aircraftId(), damageImplementations: supported });
    }).catch(() => { if (epoch === generation && !finished) link.fail("connection-failed", "Could not connect to the other pilot. Check the network and try a new invitation."); });
  }
  async function start(role: "host" | "guest") {
    if (disposed) throw new Error("Multiplayer has closed.");
    disconnect(); pilotId = randomToken(12);
    const epoch = generation;
    change({ role, status: role === "host" ? "starting" : "joining", sharedSettingsReady: role === "host", message: "Connecting to the pairing service…" });
    endpoint = (options.createEndpoint ?? createPeerEndpoint)({
      role: "desktop", protocol: { sessionLabel: "mp-session-v2", nativeLabel: "mp-pose-v2", metadata: { v: PROTOCOL_VERSION, protocol: "multiplayer" }, maxMessageBytes: 1100 },
      onConnection: link => { if (role === "host") attach(link, null, epoch); else link.close(); },
      onSignalingState: available => { if (epoch === generation && !available && state.status === "connected") change({ message: "Pairing service unavailable. The aircraft link can keep flying." }); },
    });
    try { peerId = await endpoint.ready; } catch { if (epoch === generation) fail("The pairing service is unavailable. Try again."); throw new Error("The pairing service is unavailable."); }
    if (epoch !== generation) throw new Error("Multiplayer connection cancelled.");
    return epoch;
  }
  function invite(base: string) {
    if (!endpoint || state.role !== "host" || active) throw new Error("Start a flight before creating an invitation.");
    secret = randomToken(); deadline = now() + INVITATION_LIFETIME_MS;
    const url = invitationUrl(base, { peer: peerId, secret });
    change({ status: "hosting", message: "Waiting for one pilot. This invitation expires in two minutes.", invitationUrl: url, invitationExpiresAtMs: deadline });
    const expected = deadline;
    later(() => { if (deadline === expected) { secret = ""; deadline = 0; change({ invitationUrl: null, invitationExpiresAtMs: null, message: "Invitation expired. Create a new invitation." }); } }, INVITATION_LIFETIME_MS);
    return url;
  }
  return {
    setSharedSettings(patch: SharedSettingsPatch) {
      if (disposed) throw new Error("Multiplayer has closed.");
      if (!isSharedSettingsPatch(patch)) throw new Error("Unsupported shared settings.");
      if (state.sharedSettingsPending) throw new Error("Waiting for the host to decide the previous change.");
      if (state.role === "guest") {
        if (patch.settingsEditors !== undefined) throw new Error(rejectionMessage("permission-host-only"));
        if (state.sharedSettings.settingsEditors !== "everyone") throw new Error(rejectionMessage("host-only"));
        if (!active || state.status !== "connected" || !state.sharedSettingsReady) throw new Error(rejectionMessage("not-ready"));
        const requestId = ++settingsRequestId;
        pendingSettingsRequest = requestId;
        change({ sharedSettingsPending: true, sharedSettingsError: null });
        send(active, { type: "shared-settings-request", requestId, baseRevision: state.sharedSettingsRevision, patch });
        return;
      }
      if (patch.settingsEditors !== undefined && state.role !== "host") throw new Error("Host a flight before changing multiplayer permissions.");
      const error = applySettingsPatch(patch, false, state.sharedSettingsRevision);
      if (error) throw new Error(rejectionMessage(error));
    },
    async host(base: string) { await start("host"); return invite(base); },
    invite,
    async join(input: Invitation | string) {
      const invitation = typeof input === "string" ? readInvitation(input) : input;
      if (!invitation) throw new Error("Paste a valid multiplayer invitation link.");
      const epoch = await start("guest");
      try { attach(endpoint!.connect(invitation.peer), invitation, epoch); change({ message: "Opening the aircraft link…" }); }
      catch { fail("Could not reach this flight. Ask for a new invitation."); }
    },
    update(local: LocalPose, held: boolean) {
      if (!active || state.status !== "connected" || !state.sharedSettingsReady) return;
      const link = active;
      const time = now();
      if (lastHeld !== held || (held && local.health !== lastHealth) || (!held && time >= nextPoseAt)) {
        const message: SessionMessage = { type: "pose", pose: { ...local, pilotId, seq: sequence++, tMs: time + clockOffset,
          damageImplementation: state.sharedSettings.damageImplementation, sharedSettingsRevision: state.sharedSettingsRevision } };
        const encoded = encodeMessage(message);
        if (!encoded || !parseMessage(encoded)) return;
        if (held) {
          // One ordered pose before held avoids a race with the unreliable channel.
          if (!send(link, message) || !send(link, { type: "held", pilotId, tMs: message.pose.tMs })) return;
        } else if (!link.sendNative(message)) return;
        lastSend = time;
        const period = 1000 / 30;
        if (!Number.isFinite(nextPoseAt) || lastHeld !== held) nextPoseAt = time + period;
        else nextPoseAt += (Math.floor((time - nextPoseAt) / period) + 1) * period;
        lastHeld = held;
        lastHealth = local.health;
      } else if (held && time - lastSend >= 250) {
        if (!send(link, { type: "held", pilotId, tMs: time + clockOffset })) return;
        lastSend = time;
      }
      if (!diagnosticsPending && time - lastDiagnostics >= 1000) {
        diagnosticsPending = true; lastDiagnostics = time;
        const epoch = generation;
        void link.diagnostics().then(diagnostics => { if (epoch === generation) change({ diagnostics }); })
          .catch(() => {}).finally(() => { if (epoch === generation) diagnosticsPending = false; });
      }
    },
    render() {
      const view = world.render(now() + clockOffset);
      const shown = view.aircraft[0];
      state.stale = shown?.stale ?? false; state.held = shown?.held ?? false;
      state.receiveToPresentMs = lastReceived === null ? null : Math.max(0, now() - lastReceived);
      return view;
    },
    snapshot: () => ({ ...state, sharedSettings: { ...state.sharedSettings } }),
    disconnect,
    dispose() { disconnect(); disposed = true; },
  };
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
export type ServerlessSession = ReturnType<typeof createServerlessSession>;
