import { MAX_MESSAGE_BYTES } from "./protocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One reliable JSON message, delimited so a stream can carry several. */
export function encodeReliableFrame(json: string): Uint8Array {
  return encoder.encode(`${json}\n`);
}

export function encodeDatagram(json: string): Uint8Array | null {
  const bytes = encoder.encode(json);
  return bytes.byteLength > MAX_MESSAGE_BYTES ? null : bytes;
}

export function decodeDatagram(bytes: Uint8Array): string | null {
  if (bytes.byteLength > MAX_MESSAGE_BYTES) return null;
  return decoder.decode(bytes);
}

/** Reassemble newline-delimited messages. A line over the pose cap fails the stream. */
export function createReliableDecoder(onLine: (json: string) => void, onError: () => void) {
  let buffer = "";
  let failed = false;
  return (chunk: Uint8Array) => {
    if (failed) return;
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 16_384) { failed = true; buffer = ""; onError(); return; }
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (encoder.encode(line).byteLength > MAX_MESSAGE_BYTES) { failed = true; buffer = ""; onError(); return; }
      if (line.length > 0) onLine(line);
      newline = buffer.indexOf("\n");
    }
  };
}
