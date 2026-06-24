function storageKey(slug: string): string {
  return `moments:nickname:${slug}`;
}

export function getNickname(slug: string): string | null {
  return localStorage.getItem(storageKey(slug));
}

export function setNickname(slug: string, nickname: string): void {
  localStorage.setItem(storageKey(slug), nickname);
}
