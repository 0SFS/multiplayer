import { afterEach, describe, expect, it, vi } from "vitest";
import { readInvitation, readServerInvitation } from "../src/invitation";
import { createServerRelay, type RelaySocket, type ServerRelay } from "../src/serverRelay";
import { createServerSession, type ServerSession } from "../src/serverSession";
import { pose } from "./fixture";

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
const relays: ServerRelay[] = [];
const sessions: ServerSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); for (const relay of relays.splice(0)) relay.close(); });

function setup() {
  let time = 5_000;
  const relay = createServerRelay({ now: () => time });
  relays.push(relay);
  const connect = () => { const link = couple(); relay.accept(link.server); return link.client; };
  const spawn = vi.fn();
  const host = createServerSession({ aircraftId: () => "f-35b", serverUrl: () => "https://127.0.0.1:4433/flight", certHash: () => "b".repeat(43), connect, now: () => time });
  const guest = createServerSession({ aircraftId: () => "cessna-172", serverUrl: () => "https://127.0.0.1:4433/flight", connect, now: () => time - 4_000, onSpawn: spawn });
  sessions.push(host, guest);
  return { host, guest, relay, spawn, now: () => time, advance(ms: number) { time += ms; } };
}

describe("server flight session", () => {
  it("connects two pilots through the relay and spawns the guest beside the host once", async () => {
    const { host, guest, spawn, advance } = setup();
    const invite = await host.host("https://localhost/fly/?gkey=private#old");
    expect(new URL(invite).search).toBe("");
    expect(readInvitation(invite)).toBeNull();
    const parsed = readServerInvitation(invite);
    expect(parsed).toMatchObject({ server: "https://127.0.0.1:4433/flight", certHash: "b".repeat(43) });
    host.update(pose({ aircraftId: "f-35b", northVelocityFps: 100 }), false);
    await guest.join(invite);
    await flush();
    expect(host.snapshot().status).toBe("connected");
    expect(guest.snapshot().status).toBe("connected");
    expect(guest.render().aircraft.map(item => item.pose.aircraftId)).toEqual(["f-35b"]);
    expect(guest.render().aircraft[0].stale).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
    advance(40);
    guest.update(pose({ aircraftId: "cessna-172" }), false);
    await flush();
    expect(host.render().aircraft.map(item => item.pose.aircraftId)).toEqual(["cessna-172"]);
    host.update(pose({ aircraftId: "f-35b" }), false);
    await flush();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("holds a paused aircraft and drops only the pilot who leaves", async () => {
    const { host, guest, relay, now, advance } = setup();
    const invite = await host.host("https://example.test/fly/");
    await guest.join(invite);
    host.update(pose({ aircraftId: "f-35b" }), true);
    await flush();
    advance(1_000);
    expect(guest.render().aircraft[0]).toMatchObject({ held: true, stale: false });
    guest.update(pose({ aircraftId: "cessna-172" }), false);
    const third = createServerSession({ aircraftId: () => "sf-50", serverUrl: () => "https://127.0.0.1:4433/flight",
      connect: () => { const link = couple(); relay.accept(link.server); return link.client; }, now });
    sessions.push(third);
    await third.join(invite);
    await flush();
    third.update(pose({ aircraftId: "sf-50" }), false);
    await flush();
    expect(host.render().aircraft.map(item => item.pose.aircraftId).sort()).toEqual(["cessna-172", "sf-50"]);
    third.disconnect();
    await flush();
    expect(host.snapshot().status).toBe("connected");
    expect(host.render().aircraft.map(item => item.pose.aircraftId)).toEqual(["cessna-172"]);
  });
});
