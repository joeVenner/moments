function storageKey(slug: string): string {
  return `moments:nickname:${slug}`;
}

export function getNickname(slug: string): string | null {
  return localStorage.getItem(storageKey(slug));
}

export function setNickname(slug: string, nickname: string): void {
  localStorage.setItem(storageKey(slug), nickname);
}

/** Forgets the saved nickname (another device owns it). */
export function clearNickname(slug: string): void {
  try {
    localStorage.removeItem(storageKey(slug));
  } catch {
    // Storage blocked: nothing was saved.
  }
}

function guestTokenKey(slug: string): string {
  return `moments:guest-token:${slug}`;
}

/** Per-device guest token issued by the server on join; proves nickname ownership. */
export function getGuestToken(slug: string): string | null {
  try {
    return localStorage.getItem(guestTokenKey(slug));
  } catch {
    // Storage blocked (private mode), or none at all (the upload service
    // worker): the request goes tokenless.
    return null;
  }
}

/**
 * The `X-Guest-Token` header for this event's requests, or none for a guest
 * without a token (they still work while GUEST_TOKENS_ENFORCED is off).
 */
export function guestTokenHeaders(slug: string): Record<string, string> {
  const token = getGuestToken(slug);
  return token ? { "X-Guest-Token": token } : {};
}

export function setGuestToken(slug: string, token: string): void {
  try {
    localStorage.setItem(guestTokenKey(slug), token);
  } catch {
    // Storage blocked: the next join simply issues another token.
  }
}
