export interface Invitation { peer: string; secret: string }
export const INVITATION_LIFETIME_MS = 120_000;

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
