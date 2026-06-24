const STORAGE_KEY = "moments:admin:auth";

export function getAdminAuthHeader(): string | null {
  return sessionStorage.getItem(STORAGE_KEY);
}

export function setAdminAuth(username: string, password: string): string {
  const header = `Basic ${btoa(`${username}:${password}`)}`;
  sessionStorage.setItem(STORAGE_KEY, header);
  return header;
}

export function clearAdminAuth(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}
