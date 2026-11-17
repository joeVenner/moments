function storageKey(slug: string): string {
  return `moments:nickname:${slug}`;
}

export function getNickname(slug: string): string | null {
  return localStorage.getItem(storageKey(slug));
}

export function setNickname(slug: string, nickname: string): void {
  localStorage.setItem(storageKey(slug), nickname);
}

function guestTokenKey(slug: string): string {
  return `moments:guest-token:${slug}`;
}

/** Per-device guest token issued by the server on join; proves nickname ownership. */
export function getGuestToken(slug: string): string | null {
  try {
    return localStorage.getItem(guestTokenKey(slug));
  } catch {
    return null; // Storage blocked (private mode); the guest just joins tokenless.
  }
}

export function setGuestToken(slug: string, token: string): void {
  try {
    localStorage.setItem(guestTokenKey(slug), token);
  } catch {
    // Storage blocked: the next join simply issues another token.
  }
}
