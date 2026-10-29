import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeMessage, parseMessage, type SessionMessage } from "../src/protocol";
import { createServerRelay, type RelaySocket, type ServerRelay } from "../src/serverRelay";
import { createReliableDecoder, encodeReliableFrame } from "../src/serverFrames";
import { pose, burst } from "./fixture";

const settings = { damageImplementation: "health-v1" as const, settingsEditors: "host" as const };
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function couple() {
  let closed = false;
  const sides = [0, 1].map(() => ({ reliable: null as ((value: string) => void) | null, datagram: null as ((value: string) => void) | null, close: null as ((reason: string) => void) | null }));
  function make(index: number): RelaySocket {
    return {
      sendReliable(encoded) { if (closed) return false; queueMicrotask(() => sides[1 - index].reliable?.(encoded)); return true; },
      sendDatagram(encoded) { if (closed) return false; queueMicrotask(() => sides[1 - index].datagram?.(encoded)); return true; },
      close(reason = "closed") { if (closed) return; closed = true; queueMicrotask(() => { for (const side of sides) side.close?.(reason); }); },
      onReliable(handler) { sides[index].reliable = handler; },
      onDatagram(handler) { sides[index].datagram = handler; },
      onClose(handler) { sides[index].close = handler; },
    };
  }
  return { client: make(0), server: make(1) };
}
function endpoint(relay: ServerRelay) {
  const link = couple();
  const reliable: SessionMessage[] = [];
  const datagrams: SessionMessage[] = [];
  let reason = "";
  link.client.onReliable(encoded => { const message = parseMessage(encoded); if (message) reliable.push(message); });
  link.client.onDatagram(encoded => { const message = parseMessage(encoded); if (message) datagrams.push(message); });
  link.client.onClose(next => { reason = next; });
  relay.accept(link.server);
  return { link, reliable, datagrams, reason: () => reason, send(message: SessionMessage) { const encoded = encodeMessage(message); if (!encoded) throw new Error("unencodable"); link.client.sendReliable(encoded); },
    datagram(message: SessionMessage) { const encoded = encodeMessage(message); if (!encoded) throw new Error("unencodable"); link.client.sendDatagram(encoded); } };
}
function open(pilotId = "host") {
  return { type: "open-flight" as const, v: 2, pilotId, aircraftId: "f-35b", damageImplementations: ["health-v1"] as const, settings };
}
const relays: ServerRelay[] = [];
afterEach(() => { for (const relay of relays.splice(0)) relay.close(); vi.useRealTimers(); });

describe("flight server relay", () => {
  it("gives the host a secret and relays a pose to an admitted guest", async () => {
    const relay = createServerRelay({ now: () => 1_000 });
    relays.push(relay);
    const host = endpoint(relay);
    host.send(open());
    await flush();
    const welcome = host.reliable.find(message => message.type === "welcome");
    if (welcome?.type !== "welcome" || !welcome.secret) throw new Error("missing invitation");
    const guest = endpoint(relay);
    guest.send({ type: "hello", v: 2, pilotId: "guest", secret: welcome.secret, aircraftId: "cessna-172", damageImplementations: ["health-v1"], sessionId: welcome.sessionId });
    await flush();
    guest.send({ type: "shared-settings-ack", revision: 0 });
    await flush();
    const snapshot = { type: "pose" as const, pose: pose({ pilotId: "host", damageImplementation: "health-v1", sharedSettingsRevision: 0 }) };
    host.datagram(snapshot);
    await flush();
    expect(guest.datagrams).toEqual([snapshot]);
    expect(host.datagrams).toEqual([]);
    expect(host.reliable.some(message => message.type === "pose")).toBe(false);
  });

  it("drops a rejected pose, then removes the pilot on the third strike", async () => {
    let strikes = 0;
    const relay = createServerRelay({ admission: () => ({
      pose: next => next.latDeg > 60 ? { accepted: false, dropped: false, code: "claimed-speed" } : { accepted: true, dropped: false, code: null },
      burst: () => ({ accepted: false, dropped: ++strikes >= 3, code: "origin" }),
      launch: () => ({ accepted: true, dropped: false, code: null }),
    }) });
    relays.push(relay);
    const host = endpoint(relay);
    host.send(open());
    await flush();
    const welcome = host.reliable.find(message => message.type === "welcome");
    if (welcome?.type !== "welcome" || !welcome.secret) throw new Error("missing invitation");
    host.send({ type: "shared-settings-ack", revision: 0 });
    host.datagram({ type: "pose", pose: pose({ pilotId: "host", latDeg: 70, damageImplementation: "health-v1", sharedSettingsRevision: 0 }) });
    await flush();
    expect(host.reliable.some(message => message.type === "reject" && message.code === "claimed-speed")).toBe(true);
    for (const seq of [1, 2, 3]) host.send({ type: "fire", burst: burst({ shooterId: "host", seq }) });
    await flush();
    expect(host.reason()).toBe("strikes");
  });

  it("rejects a full flight, an expired invitation, and a forged settings snapshot", async () => {
    let time = 0;
    const relay = createServerRelay({ capacity: 2, invitationLifetimeMs: 1_000, now: () => time });
    relays.push(relay);
    const host = endpoint(relay);
    host.send(open());
    await flush();
    const welcome = host.reliable.find(message => message.type === "welcome");
    if (welcome?.type !== "welcome" || !welcome.secret) throw new Error("missing invitation");
    const hello = { type: "hello" as const, v: 2, secret: welcome.secret, aircraftId: "cessna-172", damageImplementations: ["health-v1"] as const, sessionId: welcome.sessionId };
    const guest = endpoint(relay);
    guest.send({ ...hello, pilotId: "guest" });
    await flush();
    const extra = endpoint(relay);
    extra.send({ ...hello, pilotId: "extra" });
    await flush();
    expect(extra.reason()).toBe("full");
    time = 1_000;
    const late = endpoint(relay);
    guest.send({ type: "shared-settings-ack", revision: 0 });
    late.send({ ...hello, pilotId: "late" });
    await flush();
    expect(late.reason()).toBe("expired");
    guest.send({ type: "shared-settings", revision: 1, settings: { damageImplementation: "off-v1", settingsEditors: "everyone" } });
    await flush();
    expect(guest.reason()).toBe("authority");
    expect(host.reason()).toBe("");
  });

  it("holds a guest's poses until they confirm settings, then catches them up", async () => {
    const relay = createServerRelay({ now: () => 5_000 });
    relays.push(relay);
    const host = endpoint(relay);
    host.send(open());
    await flush();
    const welcome = host.reliable.find(message => message.type === "welcome");
    if (welcome?.type !== "welcome" || !welcome.secret) throw new Error("missing invitation");
    const snapshot = { type: "pose" as const, pose: pose({ pilotId: "host", tMs: 5_000, damageImplementation: "health-v1", sharedSettingsRevision: 0 }) };
    host.datagram(snapshot);
    const guest = endpoint(relay);
    guest.send({ type: "hello", v: 2, pilotId: "guest", secret: welcome.secret, aircraftId: "cessna-172", damageImplementations: ["health-v1"], sessionId: welcome.sessionId });
    await flush();
    expect(guest.datagrams).toEqual([]);
    expect(guest.reliable.some(message => message.type === "pose")).toBe(false);
    guest.send({ type: "shared-settings-ack", revision: 0 });
    await flush();
    expect(guest.reliable.some(message => message.type === "pose" && message.pose.pilotId === "host")).toBe(true);
    expect(guest.reliable.some(message => message.type === "shared-settings-ready")).toBe(true);
  });

  it("keeps the flight when the host leaves and invites from the next pilot", async () => {
    const relay = createServerRelay({ now: () => 1_000 });
    relays.push(relay);
    const host = endpoint(relay);
    host.send(open("host"));
    await flush();
    const welcome = host.reliable.find(message => message.type === "welcome");
    if (welcome?.type !== "welcome" || !welcome.secret) throw new Error("missing invitation");
    const guest = endpoint(relay);
    guest.send({ type: "hello", v: 2, pilotId: "guest", secret: welcome.secret, aircraftId: "cessna-172", damageImplementations: ["health-v1"], sessionId: welcome.sessionId });
    await flush();
    guest.send({ type: "shared-settings-ack", revision: 0 });
    await flush();
    host.link.client.close("left");
    await flush();
    expect(guest.reason()).toBe("");
    expect(guest.reliable.some(message => message.type === "removed" && message.pilotId === "host" && message.reason === "left")).toBe(true);
    expect(guest.reliable.some(message => message.type === "invitation")).toBe(true);
    expect(guest.reliable.some(message => message.type === "member" && message.pilotId === "guest" && message.host && message.present)).toBe(true);
  });

  it("reassembles a reliable frame that arrives in pieces", () => {
    const lines: string[] = [];
    let failed = false;
    const decode = createReliableDecoder(line => lines.push(line), () => { failed = true; });
    const frame = encodeReliableFrame("{\"type\":\"renew\"}");
    decode(frame.slice(0, 4));
    decode(frame.slice(4));
    expect(lines).toEqual(["{\"type\":\"renew\"}"]);
    expect(failed).toBe(false);
  });
});
