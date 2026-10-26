import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createPeerEndpoint, SessionTransport } from "@0sfs/rc/peerTransport";
import { createServerlessSession, type ServerlessSession } from "../src/serverlessSession";
import { invitationUrl, readInvitation } from "../src/invitation";
import { pose } from "./fixture";

function network() {
  let nextId = 0;
  const endpoints = new Map<string, { onConnection?: (link: SessionTransport) => void }>();
  const owners = new Map<string, SessionTransport[]>();
  const sent: { channel: string; value: unknown }[] = [];
  const links: SessionTransport[] = [];
  const factory = ((options: { onConnection?: (link: SessionTransport) => void }) => {
    const id = `peer-${++nextId}`;
    endpoints.set(id, options);
    const owned: SessionTransport[] = [];
    owners.set(id, owned);
    return {
      ready: Promise.resolve(id),
      connect(target: string) {
        let closed = false;
        const handlers = [0, 1].map(() => ({ reliable: new Set<(value: unknown) => void>(), native: new Set<(value: unknown) => void>(), close: new Set<(reason: string) => void>() }));
        function link(side: number): SessionTransport {
          let nativeId: number | null = null;
          const item = {
            id: `${id}-${target}`, peerId: side ? id : target, ready: Promise.resolve(),
            get nativeStreamId() { return nativeId; }, get nativeOpen() { return nativeId !== null; }, nativeBufferedAmount: 0,
            onReliable(fn: (value: unknown) => void) { handlers[side].reliable.add(fn); return () => handlers[side].reliable.delete(fn); },
            onNative(fn: (value: unknown) => void) { handlers[side].native.add(fn); return () => handlers[side].native.delete(fn); },
            onClose(fn: (reason: string) => void) { handlers[side].close.add(fn); return () => handlers[side].close.delete(fn); },
            sendReliable(value: unknown) { return send("reliable", side, value); },
            sendNative(value: unknown) { return send("native", side, value); },
            openNative(stream = 1) { nativeId = stream; return Promise.resolve(stream); },
            diagnostics: async () => ({ path: "direct", iceRttMs: 4, ordered: false, maxRetransmits: 0, bufferedAmount: 0 }),
            fail() { item.close(); },
            close() { if (closed) return; closed = true; for (const group of handlers) for (const fn of group.close) fn("closed"); },
          } as SessionTransport;
          return item;
        }
        function send(channel: "reliable" | "native", side: number, value: unknown) {
          if (closed) return false;
          sent.push({ channel, value });
          const copy = JSON.parse(JSON.stringify(value));
          queueMicrotask(() => { if (!closed) for (const fn of handlers[1 - side][channel]) fn(copy); });
          return true;
        }
        const outgoing = link(0), incoming = link(1);
        owned.push(outgoing); links.push(outgoing, incoming);
        owners.get(target)?.push(incoming);
        endpoints.get(target)?.onConnection?.(incoming);
        return outgoing;
      },
      destroy() { endpoints.delete(id); for (const link of owned) link.close(); },
    };
  }) as unknown as typeof createPeerEndpoint;
  return { factory, sent, links };
}
const sessions: ServerlessSession[] = [];
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); vi.useRealTimers(); });
function setup(options: { host?: Partial<Parameters<typeof createServerlessSession>[0]>; guest?: Partial<Parameters<typeof createServerlessSession>[0]> } = {}) {
  const net = network();
  let time = 5000;
  const spawn = vi.fn();
  const host = createServerlessSession({ aircraftId: () => "f-35b", createEndpoint: net.factory, now: () => time, ...options.host });
  const guest = createServerlessSession({ aircraftId: () => "cessna-172", createEndpoint: net.factory, now: () => time - 4000, onSpawn: spawn, ...options.guest });
  sessions.push(host, guest);
  return { net, host, guest, spawn, advance(ms: number) { time += ms; } };
}

describe("two-pilot serverless flight", () => {
  it("authenticates, agrees a clock, sends aircraft on the native channel, and spawns once", async () => {
    const { host, guest, net, spawn, advance } = setup();
    const invite = await host.host("https://localhost/fly/?gkey=private#old");
    expect(new URL(invite).search).toBe("");
    await guest.join(invite); await flush();
    expect(host.snapshot().status).toBe("connected"); expect(guest.snapshot().status).toBe("connected");
    expect(host.snapshot().invitationUrl).toBeNull();
    host.update(pose({ aircraftId: "f-35b", northVelocityFps: 100 }), false); await flush();
    expect(guest.render().aircraft[0].pose.aircraftId).toBe("f-35b");
    expect(guest.render().aircraft[0].stale).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
    guest.update(pose({ aircraftId: "cessna-172" }), false); await flush();
    expect(host.render().aircraft[0].pose.aircraftId).toBe("cessna-172");
    expect(net.sent.filter(item => (item.value as { type: string }).type === "pose").every(item => item.channel === "native")).toBe(true);
    advance(40); host.update(pose(), false); await flush(); expect(spawn).toHaveBeenCalledTimes(1);
  });
  it("holds a paused aircraft reliably and resumes with a newer pose", async () => {
    const { host, guest, advance, spawn } = setup();
    await guest.join(await host.host("https://example.test/fly/")); await flush();
    host.update(pose({ northVelocityFps: 100 }), true); await flush();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(guest.snapshot().receiveToPresentMs).toBeNull();
    guest.render();
    expect(guest.snapshot().receiveToPresentMs).toBe(0);
    advance(1000);
    expect(guest.render().aircraft[0]).toMatchObject({ held: true, stale: false, leadMs: 0 });
    host.update(pose({ latDeg: 45 }), false); await flush();
    expect(guest.render().aircraft[0]).toMatchObject({ held: false, stale: false });
    expect(guest.render().aircraft[0].pose.latDeg).toBe(45);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it("bounds extrapolation when updates stop and removes the aircraft on disconnect", async () => {
    const { host, guest, advance } = setup();
    await guest.join(await host.host("https://example.test/fly/")); await flush();
    host.update(pose(), false); await flush(); advance(300);
    expect(guest.render().aircraft[0]).toMatchObject({ stale: true, leadMs: 100 });
    host.disconnect(); await flush();
    expect(guest.snapshot().status).toBe("error"); expect(guest.render().aircraft).toEqual([]);
  });
  it("publishes damage and repairs while paused without repeatedly resending an unchanged pose", async () => {
    const { host, guest, net } = setup();
    await guest.join(await host.host("https://example.test/fly/")); await flush();
    host.update(pose({ health: 100 }), true); await flush();
    for (const health of [75, 0, 100]) {
      host.update(pose({ health }), true); await flush();
      expect(guest.render().aircraft[0]).toMatchObject({ held: true, pose: { health } });
    }
    const sent = net.sent.length;
    host.update(pose({ health: 100 }), true); await flush();
    expect(net.sent).toHaveLength(sent);
    expect(net.sent.filter(item => (item.value as { type: string }).type === "pose").every(item => item.channel === "reliable")).toBe(true);
  });
  it("rejects an expired invitation and forgets its URL", async () => {
    const { host, guest, advance } = setup();
    const invite = await host.host("https://example.test/fly/");
    advance(120_001); await vi.advanceTimersByTimeAsync(120_001);
    expect(host.snapshot().invitationUrl).toBeNull();
    await guest.join(invite); await flush(); expect(guest.snapshot().status).toBe("error");
    expect(host.snapshot().status).toBe("hosting");
  });
  it("rejects a snapshot claiming another pilot's identity", async () => {
    const { host, guest, net } = setup();
    await guest.join(await host.host("https://example.test/fly/")); await flush();
    net.links[0].sendNative({ type: "pose", pose: pose({ pilotId: "impostor", tMs: 5000 }) }); await flush();
    expect(host.render().aircraft).toEqual([]);
    expect(host.snapshot().status).toBe("error");
  });
  it("does not create an endpoint until the pilot hosts or joins", () => {
    const createEndpoint = vi.fn();
    const session = createServerlessSession({ aircraftId: () => "f-35b", createEndpoint }); sessions.push(session);
    session.update(pose(), false); session.render(); expect(createEndpoint).not.toHaveBeenCalled();
  });
  it("keeps the 30 Hz cadence with rounded browser timers", async () => {
    const { host, guest, net, advance } = setup();
    await guest.join(await host.host("https://example.test/fly/")); await flush();
    for (let i = 0; i < 31; i++) { host.update(pose(), false); advance(33); }
    const snapshots = net.sent.filter(item => item.channel === "native");
    expect(snapshots.length).toBe(30);
  });
  it("closes cleanly if the reliable channel fails during a pause", async () => {
    const { host, guest, net } = setup();
    await guest.join(await host.host("https://example.test/fly/")); await flush();
    net.links[1].sendReliable = () => false;
    expect(() => host.update(pose(), true)).not.toThrow();
    expect(host.snapshot().status).toBe("error");
  });
});

describe("host-authorized shared settings", () => {
  it("installs the host's implementation before either peer becomes connected", async () => {
    const { host, guest } = setup();
    host.setSharedSettings({ damageImplementation: "off-v1" });
    await guest.join(await host.host("https://example.test/fly/"));
    expect(guest.snapshot().status).not.toBe("connected");
    await flush();
    for (const session of [host, guest]) {
      expect(session.snapshot()).toMatchObject({ status: "connected", sharedSettingsReady: true,
        sharedSettings: { damageImplementation: "off-v1", settingsEditors: "host" } });
    }
    const copy = guest.snapshot(); copy.sharedSettings.settingsEditors = "everyone";
    expect(guest.snapshot().sharedSettings.settingsEditors).toBe("host");
  });

  it("blocks guest edits by default at both the public API and receiving host", async () => {
    const { host, guest, net } = setup();
    await guest.join(await host.host("https://example.test/fly/")); await flush();
    expect(() => guest.setSharedSettings({ damageImplementation: "off-v1" })).toThrow("Only the host");
    net.links[0].sendReliable({ type: "shared-settings-request", requestId: 1, baseRevision: 0,
      patch: { damageImplementation: "off-v1" } }); await flush();
    expect(host.snapshot().sharedSettings.damageImplementation).toBe("health-v1");
    expect(net.sent.some(item => (item.value as { error?: string }).error === "host-only")).toBe(true);
  });

  it("lets the host grant and revoke editing, while retaining permission authority", async () => {
    const { host, guest, net } = setup();
    await guest.join(await host.host("https://example.test/fly/")); await flush();
    host.setSharedSettings({ settingsEditors: "everyone" }); await flush();
    expect(guest.snapshot().sharedSettings.settingsEditors).toBe("everyone");
    expect(() => guest.setSharedSettings({ settingsEditors: "host" })).toThrow("who may edit");
    net.links[0].sendReliable({ type: "shared-settings-request", requestId: 9,
      baseRevision: guest.snapshot().sharedSettingsRevision, patch: { settingsEditors: "host" } }); await flush();
    expect(host.snapshot().sharedSettings.settingsEditors).toBe("everyone");
    expect(net.sent.some(item => (item.value as { error?: string }).error === "permission-host-only")).toBe(true);
    guest.setSharedSettings({ damageImplementation: "off-v1" });
    expect(guest.snapshot()).toMatchObject({ sharedSettingsPending: true, sharedSettings: { damageImplementation: "health-v1" } });
    await flush();
    expect(host.snapshot().sharedSettings).toEqual(guest.snapshot().sharedSettings);
    expect(guest.snapshot()).toMatchObject({ sharedSettingsPending: false, sharedSettingsReady: true,
      sharedSettings: { damageImplementation: "off-v1" } });
    host.setSharedSettings({ settingsEditors: "host" }); await flush();
    expect(() => guest.setSharedSettings({ damageImplementation: "health-v1" })).toThrow("Only the host");
  });

  it("rejects stale requests and never displays poses from an older settings revision", async () => {
    const { host, guest, net } = setup();
    await guest.join(await host.host("https://example.test/fly/")); await flush();
    host.update(pose({ health: 75 }), true); await flush();
    const oldPose = net.sent.find(item => (item.value as { type: string }).type === "pose")!.value;
    host.setSharedSettings({ settingsEditors: "everyone" }); await flush();
    net.links[0].sendReliable({ type: "shared-settings-request", requestId: 2, baseRevision: 0,
      patch: { damageImplementation: "off-v1" } }); await flush();
    expect(host.snapshot().sharedSettings.damageImplementation).toBe("health-v1");
    expect(net.sent.some(item => (item.value as { error?: string }).error === "stale")).toBe(true);
    net.links[1].sendNative(oldPose); await flush();
    expect(guest.render().aircraft).toEqual([]);
    host.update(pose({ health: 75 }), true); await flush();
    expect(guest.render().aircraft[0].pose).toMatchObject({ health: 75, sharedSettingsRevision: 1, damageImplementation: "health-v1" });
  });

  it("refuses a peer that cannot run the selected damage implementation", async () => {
    const { host, guest } = setup({ guest: {
      supportedDamageImplementations: ["off-v1"], initialSharedSettings: { damageImplementation: "off-v1", settingsEditors: "host" },
    } });
    await guest.join(await host.host("https://example.test/fly/")); await flush();
    expect(host.snapshot().status).toBe("error"); expect(guest.snapshot().status).toBe("error");
    expect(host.render().aircraft).toEqual([]);
  });

  it("refuses a later implementation that an admitted peer cannot run", async () => {
    const { host, guest } = setup({ guest: { supportedDamageImplementations: ["health-v1"] } });
    await guest.join(await host.host("https://example.test/fly/")); await flush();
    expect(() => host.setSharedSettings({ damageImplementation: "off-v1" })).toThrow("every pilot");
    expect(host.snapshot()).toMatchObject({ status: "connected", sharedSettingsReady: true,
      sharedSettings: { damageImplementation: "health-v1" } });
  });

  it("rechecks current permissions when a previously allowed request arrives after revocation", async () => {
    const { host, guest } = setup();
    await guest.join(await host.host("https://example.test/fly/")); await flush();
    host.setSharedSettings({ settingsEditors: "everyone" }); await flush();
    guest.setSharedSettings({ damageImplementation: "off-v1" });
    host.setSharedSettings({ settingsEditors: "host" }); await flush();
    expect(host.snapshot().sharedSettings).toEqual({ damageImplementation: "health-v1", settingsEditors: "host" });
    expect(guest.snapshot().sharedSettings).toEqual(host.snapshot().sharedSettings);
    expect(guest.snapshot().sharedSettingsPending).toBe(false);
  });

  it("ends an unsynchronized session when an acknowledgement never arrives", async () => {
    const { host, guest, net } = setup();
    await guest.join(await host.host("https://example.test/fly/")); await flush();
    const send = net.links[0].sendReliable;
    net.links[0].sendReliable = value => (value as { type: string }).type === "shared-settings-ack" || send(value);
    host.setSharedSettings({ damageImplementation: "off-v1" }); await flush();
    expect(host.snapshot().sharedSettingsReady).toBe(false); expect(guest.snapshot().sharedSettingsReady).toBe(false);
    const poses = () => net.sent.filter(item => (item.value as { type: string }).type === "pose").length;
    const count = poses(); host.update(pose(), false); guest.update(pose(), false);
    expect(poses()).toBe(count);
    await vi.advanceTimersByTimeAsync(5001); await flush();
    expect(host.snapshot().status).toBe("error"); expect(guest.snapshot().status).toBe("error");
  });

  it("does not accept a guest pretending to be the settings publisher", async () => {
    const { host, guest, net } = setup();
    await guest.join(await host.host("https://example.test/fly/")); await flush();
    net.links[0].sendReliable({ type: "shared-settings", revision: 5,
      settings: { damageImplementation: "off-v1", settingsEditors: "everyone" } }); await flush();
    expect(host.snapshot().status).toBe("error");
    expect(host.snapshot().sharedSettings.damageImplementation).toBe("health-v1");
  });
});

describe("invitation fragments", () => {
  it("keeps a credential in the fragment and rejects invalid versions or tokens", () => {
    const invitation = { peer: "peer-1", secret: "x".repeat(43) };
    const url = invitationUrl("https://example.test/fly/", invitation);
    expect(readInvitation(url)).toEqual(invitation);
    expect(readInvitation(url.replace("v=1", "v=2"))).toBeNull();
    expect(readInvitation(url.replace("x".repeat(43), "bad"))).toBeNull();
  });
});
