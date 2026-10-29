export interface Invitation { peer: string; secret: string }
export interface ServerInvitation { server: string; session: string; secret: string; certHash: string | null }
export const INVITATION_LIFETIME_MS = 120_000;
const CERT_HASH = /^[A-Za-z0-9_-]{43}$/;

export function randomToken(bytes = 32): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...values)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function readInvitation(href: string): Invitation | null {
  try {
    const fragment = href.startsWith("#") ? href.slice(1) : new URL(href).hash.slice(1);
    const params = new URLSearchParams(fragment);
    if (params.get("mp") !== "1" || params.get("v") !== "1") return null;
    const peer = params.get("peer"), secret = params.get("join");
    if (!peer || !/^[A-Za-z0-9_-]{1,128}$/.test(peer) || !secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
    return { peer, secret };
  } catch { return null; }
}

export function invitationUrl(base: string, invitation: Invitation): string {
  const url = new URL(base);
  // Invitations never copy a map key or another visit's test/settings payload.
  url.search = "";
  url.hash = new URLSearchParams({ mp: "1", v: "1", peer: invitation.peer, join: invitation.secret }).toString();
  return url.href;
}

/** HTTPS flight-server URL with no credentials and no fragment. */
export function readFlightServerUrl(value: string): string | null {
  if (!value || value.length > 200) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || !url.hostname) return null;
    return url.href;
  } catch { return null; }
}

export function readServerInvitation(href: string): ServerInvitation | null {
  try {
    const fragment = href.startsWith("#") ? href.slice(1) : new URL(href).hash.slice(1);
    const params = new URLSearchParams(fragment);
    if (params.get("mp") !== "1" || params.get("v") !== "1" || params.has("peer")) return null;
    const server = readFlightServerUrl(params.get("server") ?? "");
    const session = params.get("session");
    const secret = params.get("join");
    const cert = params.get("cert");
    if (!server || !session || !/^[A-Za-z0-9_-]{16,32}$/.test(session) || !secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
    if (cert !== null && !CERT_HASH.test(cert)) return null;
    return { server, session, secret, certHash: cert };
  } catch { return null; }
}

export function serverInvitationUrl(base: string, invitation: ServerInvitation): string {
  const url = new URL(base);
  url.search = "";
  const params = new URLSearchParams({ mp: "1", v: "1", server: invitation.server, session: invitation.session, join: invitation.secret });
  if (invitation.certHash) params.set("cert", invitation.certHash);
  url.hash = params.toString();
  return url.href;
}
