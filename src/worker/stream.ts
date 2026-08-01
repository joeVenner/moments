import type { Env } from "./types";

export function isStreamConfigured(env: Env): boolean {
  return Boolean(env.STREAM_ACCOUNT_ID && env.STREAM_API_TOKEN && env.STREAM_CUSTOMER_CODE);
}

export function streamApiUrl(env: Env, suffix = ""): string {
  return `https://api.cloudflare.com/client/v4/accounts/${env.STREAM_ACCOUNT_ID}/stream${suffix}`;
}

export function streamAuthHeaders(env: Env): Record<string, string> {
  return { Authorization: `Bearer ${env.STREAM_API_TOKEN}` };
}

export function streamMediaUrl(env: Env, uid: string): string {
  return `https://customer-${env.STREAM_CUSTOMER_CODE}.cloudflarestream.com/${uid}/iframe`;
}
