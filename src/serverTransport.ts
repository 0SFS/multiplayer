import type { RelaySocket } from "./serverRelay";
import { createReliableDecoder, decodeDatagram, encodeDatagram, encodeReliableFrame } from "./serverFrames";

export interface ServerTarget { url: string; certHash: string | null }

/** Browser WebTransport session: one reliable stream, datagrams for poses. */
export function connectWebTransport(target: ServerTarget): Promise<RelaySocket> {
  if (typeof WebTransport === "undefined") return Promise.reject(new Error("This browser has no WebTransport support."));
  const hash = target.certHash ? decodeBase64Url(target.certHash) : null;
  const transport = new WebTransport(target.url, hash ? { serverCertificateHashes: [{ algorithm: "sha-256", value: hash }] } : undefined);
  return transport.ready.then(() => transport.createBidirectionalStream()).then(stream => openSocket(transport, stream));
}

function openSocket(transport: WebTransport, stream: WebTransportBidirectionalStream): RelaySocket {
  let reliableHandler: ((encoded: string) => void) | null = null;
  let datagramHandler: ((encoded: string) => void) | null = null;
  let closeHandler: ((reason: string) => void) | null = null;
  let closed = false;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let reliableChain = Promise.resolve();
  let datagramPending = false;
  let latest: Uint8Array | null = null;
  const fail = (reason: string) => {
    if (closed) return;
    closed = true;
    closeHandler?.(reason);
    transport.close();
  };
  const decoder = createReliableDecoder(line => reliableHandler?.(line), () => fail("invalid"));
  const reader = stream.readable.getReader();
  const pump = async () => {
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) { fail("closed"); return; }
        decoder(result.value);
      }
    } catch { fail("closed"); }
  };
  void pump();
  writer = stream.writable.getWriter();
  const datagramWriter = transport.datagrams.writable.getWriter();
  void pumpDatagrams(transport, bytes => datagramHandler?.(bytes), () => fail("closed"));
  async function flushDatagrams() {
    while (latest && !closed) {
      const bytes = latest;
      latest = null;
      try { await datagramWriter.write(bytes); } catch { fail("closed"); return; }
    }
    datagramPending = false;
    if (latest && !closed) { datagramPending = true; void flushDatagrams(); }
  }
  return {
    sendReliable(encoded) {
      if (closed || !writer) return false;
      const bytes = encodeReliableFrame(encoded);
      reliableChain = reliableChain.then(() => writer?.write(bytes)).then(() => undefined, () => fail("closed"));
      return true;
    },
    sendDatagram(encoded) {
      if (closed) return false;
      const bytes = encodeDatagram(encoded);
      if (!bytes) return false;
      latest = bytes;
      if (!datagramPending) { datagramPending = true; void flushDatagrams(); }
      return true;
    },
    close(reason = "closed") {
      if (closed) return;
      closed = true;
      void reliableChain.finally(() => { transport.close(); closeHandler?.(reason); });
    },
    onReliable(handler) { reliableHandler = handler; },
    onDatagram(handler) { datagramHandler = handler; },
    onClose(handler) { closeHandler = handler; },
  };
}

async function pumpDatagrams(transport: WebTransport, onText: (encoded: string) => void, onError: () => void) {
  const reader = transport.datagrams.readable.getReader();
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) { onError(); return; }
      const text = decodeDatagram(result.value);
      if (text) onText(text);
    }
  } catch { onError(); }
}

function decodeBase64Url(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
