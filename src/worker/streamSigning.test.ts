import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { buildMomentMedia } from "./media";
import {
  shouldSignStream,
  signStreamMoments,
  signStreamToken,
  streamUidOf,
  streamUploadMetadata,
  syncStreamSigning,
  tokenExpiry,
} from "./streamSigning";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";
import type { Env } from "./types";

const UID = "0123456789abcdef0123456789abcdef";
const HOST = "https://customer-abc123.cloudflarestream.com";
const IFRAME = `${HOST}/${UID}/iframe`;
let publicKey: CryptoKey;
let jwkBase64: string;
let sqlite: SqliteD1;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  publicKey = pair.publicKey;
  jwkBase64 = btoa(JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)));
});

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: sqlite?.db,
    BUCKET: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    ADMIN_USER: "admin",
    ADMIN_PASSWORD: "secret",
    ADMIN_AUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    EVENT_ACCESS_SECRET: "test-access-secret-123",
    STREAM_ACCOUNT_ID: "acct-test",
    STREAM_API_TOKEN: "stream-token-test",
    STREAM_CUSTOMER_CODE: "abc123",
    STREAM_SIGNING_KEY_ID: "key-test-1",
    STREAM_SIGNING_JWK: jwkBase64,
    ...overrides,
  };
}

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
}

function fromBase64Url(part: string): Uint8Array {
  const binary = atob(part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("signStreamToken", () => {
  it("produces a verifiable RS256 token bound to the uid, key and expiry", async () => {
    const token = await signStreamToken(env(), UID, 1_800_000_000);
    const [header, payload, signature] = token.split(".");
    expect(decodePart(header)).toEqual({ alg: "RS256", kid: "key-test-1" });
    expect(decodePart(payload)).toEqual({ sub: UID, kid: "key-test-1", exp: 1_800_000_000 });
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      fromBase64Url(signature),
      new TextEncoder().encode(`${header}.${payload}`)
    );
    expect(valid).toBe(true);
    expect(token).not.toMatch(/[+/=]/);
  });

  it("is stable for the same uid and expiry", async () => {
    expect(await signStreamToken(env(), UID, 1_800_000_000)).toBe(await signStreamToken(env(), UID, 1_800_000_000));
  });

  it("refuses anything that is not a Stream uid", async () => {
    await expect(signStreamToken(env(), "../x", 1)).rejects.toThrow("invalid Stream uid");
  });
});

describe("tokenExpiry", () => {
  it("expires 1-2 hours out on an hour boundary", () => {
    for (const now of [1_800_000_000, 1_800_003_599, 1_799_996_400]) {
      const exp = tokenExpiry(now);
      expect(exp % 3600).toBe(0);
      expect(exp - now).toBeGreaterThan(3600);
      expect(exp - now).toBeLessThanOrEqual(7200);
    }
  });
});

describe("shouldSignStream", () => {
  it("signs only private events with a configured key", () => {
    expect(shouldSignStream(env(), { access_mode: "private" })).toBe(true);
    expect(shouldSignStream(env(), { access_mode: "public" })).toBe(false);
    expect(shouldSignStream(env({ STREAM_SIGNING_JWK: undefined }), { access_mode: "private" })).toBe(false);
  });
});

describe("signStreamMoments", () => {
  it("swaps the uid for a token in media_url and the media object", async () => {
    const media = buildMomentMedia({ event_id: "e1", media_url: IFRAME, mime_type: "video/mp4" });
    const [signed] = await signStreamMoments(env(), [{ media_url: IFRAME, media }], 1_800_000_000);
    const token = await signStreamToken(env(), UID, tokenExpiry(1_800_000_000));
    expect(signed.media_url).toBe(`${HOST}/${token}/iframe`);
    expect(signed.media).toMatchObject({
      url: `${HOST}/${token}/iframe`,
      hls_url: `${HOST}/${token}/manifest/video.m3u8`,
      poster_url: `${HOST}/${token}/thumbnails/thumbnail.jpg`,
    });
    expect(JSON.stringify(signed)).not.toContain(`/${UID}/`);
  });

  it("leaves R2 moments and stored R2 posters alone", async () => {
    const r2: { media_url: string; media?: ReturnType<typeof buildMomentMedia> } = {
      media_url: "/media/events/e1/moments/a.jpg",
    };
    const media = buildMomentMedia({
      event_id: "e1",
      media_url: IFRAME,
      mime_type: "video/mp4",
      poster_key: "events/e1/posters/p.jpg",
    });
    const [plain, video] = await signStreamMoments(env(), [r2, { media_url: IFRAME, media }]);
    expect(plain).toBe(r2);
    expect(video.media?.poster_url).toBe("/media/events/e1/posters/p.jpg");
  });
});

describe("streamUidOf", () => {
  it("only reads uids from Stream customer hosts", () => {
    expect(streamUidOf(IFRAME)).toBe(UID);
    expect(streamUidOf(`https://evil.example/${UID}/iframe`)).toBeNull();
    expect(streamUidOf(null)).toBeNull();
  });
});

describe("streamUploadMetadata", () => {
  it("adds requiresignedurls only when required, ignoring the client's choice", () => {
    expect(streamUploadMetadata("name YS5tcDQ=,filetype dmlkZW8vbXA0", true)).toBe(
      "name YS5tcDQ=,filetype dmlkZW8vbXA0,requiresignedurls"
    );
    expect(streamUploadMetadata("name YS5tcDQ=,requiresignedurls", false)).toBe("name YS5tcDQ=");
    expect(streamUploadMetadata("RequireSignedURLs dHJ1ZQ==", true)).toBe("requiresignedurls");
    expect(streamUploadMetadata("", false)).toBe("");
  });

  it("forwards only allowlisted, well-formed keys", () => {
    const web = "name YS5tcDQ=,filetype dmlkZW8vbXA0,maxDurationSeconds MzYwMA==";
    expect(streamUploadMetadata(web, false)).toBe(web);
    expect(
      streamUploadMetadata(
        "name YQ==,allowedorigins ZXZpbC5jb20=,expiry MjA=,scheduleddeletion MjA=,watermark eA==,name Yg==",
        false
      )
    ).toBe("name YQ==");
    expect(streamUploadMetadata("requiresignedurls\tZmFsc2U=,name YQ==", false)).toBe("name YQ==");
    expect(streamUploadMetadata("name  YQ== extra", false)).toBe("");
    expect(streamUploadMetadata("name not*base64", false)).toBe("");
    expect(streamUploadMetadata(`name ${"A".repeat(5000)}`, true)).toBe("requiresignedurls");
  });
});

describe("with a database", () => {
  beforeEach(() => {
    sqlite = createSqliteD1();
    sqlite.raw.prepare("INSERT INTO events (id, slug, title, type, access_mode) VALUES ('ev-1', 'party', 'P', 'Party', 'public')").run();
    sqlite.raw.prepare("INSERT INTO events (id, slug, title, type, access_mode) VALUES ('ev-2', 'secret', 'S', 'Party', 'private')").run();
    for (const [id, eventId] of [["v1", "ev-1"], ["v2", "ev-2"]]) {
      sqlite.raw
        .prepare("INSERT INTO moments (id, event_id, uploader_name, media_url, mime_type) VALUES (?, ?, 'Sara', ?, 'video/mp4')")
        .run(id, eventId, IFRAME);
    }
    sqlite.raw
      .prepare("INSERT INTO moments (id, event_id, uploader_name, media_url, mime_type) VALUES ('p1', 'ev-2', 'Sara', '/media/events/ev-2/a.jpg', 'image/jpeg')")
      .run();
  });

  it("syncStreamSigning updates each Stream video of the event once", async () => {
    sqlite.raw
      .prepare("INSERT INTO moments (id, event_id, uploader_name, media_url) VALUES ('v3', 'ev-2', 'Sara', ?)")
      .run(IFRAME);
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await syncStreamSigning(env(), "ev-2", true)).toEqual({ updated: 1, failed: 0 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/acct-test/stream/${UID}`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ uid: UID, requireSignedURLs: true });
  });

  it("syncStreamSigning counts failures without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no", { status: 500 })));
    expect(await syncStreamSigning(env(), "ev-2", true)).toEqual({ updated: 0, failed: 1 });
  });

  async function get(path: string, overrides: Partial<Env> = {}) {
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const grant = await (await import("./eventAccess")).signAccessGrant("test-access-secret-123", {
      eventId: "ev-2",
      accessVersion: 1,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });
    return worker.fetch(
      new Request(`https://moments.test${path}`, { headers: { "X-Event-Access": grant } }),
      env(overrides),
      ctx
    );
  }

  it.each(["/api/events/secret/moments", "/api/events/secret/highlights", "/api/v1/events/secret/feed"])(
    "%s returns signed Stream URLs for a private event",
    async (path) => {
      const body = JSON.stringify(await (await get(path)).json());
      expect(body).not.toContain(`/${UID}/`);
      expect(body).toMatch(/cloudflarestream\.com\/[\w-]+\.[\w-]+\.[\w-]+\/iframe/);
      expect(body).toContain("/media/events/ev-2/a.jpg");
    }
  );

  it("keeps plain URLs for public events and when signing is not configured", async () => {
    expect(JSON.stringify(await (await get("/api/events/party/moments")).json())).toContain(`/${UID}/iframe`);
    const unsigned = await get("/api/events/secret/moments", { STREAM_SIGNING_JWK: undefined });
    expect(JSON.stringify(await unsigned.json())).toContain(`/${UID}/iframe`);
  });

  it("asks Stream for signed URLs when a private event's guest starts a tus upload", async () => {
    sqlite.raw
      .prepare(
        "INSERT INTO uploads (id, event_id, uploader_name, key, upload_id, content_type, size_bytes, status) VALUES ('s1', 'ev-2', 'Sara', 'stream-session/s1', 's1', 'video/mp4', 1000, 'open')"
      )
      .run();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 201, headers: { Location: "https://upload.example/x", "stream-media-id": UID } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const grant = await (await import("./eventAccess")).signAccessGrant("test-access-secret-123", {
      eventId: "ev-2",
      accessVersion: 1,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });
    const res = await worker.fetch(
      new Request("https://moments.test/api/events/secret/moments/stream/tus?session=s1", {
        method: "POST",
        headers: {
          "X-Event-Access": grant,
          "Tus-Resumable": "1.0.0",
          "Upload-Length": "1000",
          "Upload-Metadata": "filetype dmlkZW8vbXA0",
        },
      }),
      env(),
      ctx
    );
    expect(res.status).toBe(201);
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["Upload-Metadata"]).toBe("filetype dmlkZW8vbXA0,requiresignedurls");
  });

  it.each([
    ["not base64", "%%%"],
    ["not RSA", btoa(JSON.stringify({ kty: "EC", d: "x" }))],
    ["public key only", btoa(JSON.stringify({ kty: "RSA", n: "x", e: "AQAB" }))],
  ])("fails closed with 503 when the key is %s", async (_label, jwk) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const path of ["/api/events/secret/moments", "/api/v1/events/secret/feed"]) {
      const res = await get(path, { STREAM_SIGNING_KEY_ID: `bad-${_label}`, STREAM_SIGNING_JWK: jwk });
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).toContain("stream_signing_unavailable");
      expect(text).not.toContain(UID);
    }
    expect(JSON.stringify(errors.mock.calls)).not.toContain(jwk.slice(0, 8) === "%%%" ? "%%%" : jwk.slice(4, 24));
    errors.mockRestore();
  });

  it("signs /feed/changes and the admin moderation response", async () => {
    const changes = JSON.stringify(await (await get("/api/events/secret/feed/changes?since=0")).json());
    expect(changes).not.toContain(`/${UID}/`);
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const res = await worker.fetch(
      new Request("https://moments.test/api/admin/moments/v2", {
        method: "PATCH",
        headers: { Authorization: `Basic ${btoa("admin:secret")}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "hidden" }),
      }),
      env(),
      ctx
    );
    const body = (await res.json()) as { moment: { media_url: string } };
    expect(body.moment.media_url).not.toContain(UID);
    expect(body.moment.media_url).toMatch(/\/iframe$/);
  });

  describe("stream/complete", () => {
    const NEW_UID = "fedcba9876543210fedcba9876543210";

    beforeEach(() => {
      sqlite.raw
        .prepare(
          "INSERT INTO uploads (id, event_id, uploader_name, key, upload_id, content_type, size_bytes, status) VALUES ('u1', 'ev-2', 'Sara', ?, ?, 'video/mp4', 1000, 'open')"
        )
        .run(`stream/${NEW_UID}`, NEW_UID);
    });

    function stubStream(requireSignedURLs: boolean, updateStatus = 200) {
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") return new Response("{}", { status: updateStatus });
        return Response.json({ success: true, result: { uid: NEW_UID, size: 1000, requireSignedURLs } });
      });
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    async function complete(overrides: Partial<Env> = {}) {
      const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
      const grant = await (await import("./eventAccess")).signAccessGrant("test-access-secret-123", {
        eventId: "ev-2",
        accessVersion: 1,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      });
      return worker.fetch(
        new Request("https://moments.test/api/events/secret/moments/stream/complete", {
          method: "POST",
          headers: { "X-Event-Access": grant, "Content-Type": "application/json" },
          body: JSON.stringify({ stream_uid: NEW_UID, uploader_name: "Sara" }),
        }),
        env(overrides),
        ctx
      );
    }

    const momentCount = () =>
      (sqlite.raw.prepare("SELECT COUNT(*) AS n FROM moments WHERE media_url LIKE ?").get(`%${NEW_UID}%`) as { n: number }).n;

    it("locks a video that was uploaded unsigned, then returns a signed URL", async () => {
      const fetchMock = stubStream(false);
      const res = await complete();
      expect(res.status).toBe(201);
      const update = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      expect(JSON.parse(String(update?.[1]?.body))).toEqual({ uid: NEW_UID, requireSignedURLs: true });
      expect(JSON.stringify(await res.json())).not.toContain(NEW_UID);
      expect(momentCount()).toBe(1);
    });

    it("does not commit when Stream refuses the lock (client can retry)", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      stubStream(false, 500);
      expect((await complete()).status).toBe(502);
      expect(momentCount()).toBe(0);
    });

    it("does not commit when the key cannot sign", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      stubStream(true);
      expect((await complete({ STREAM_SIGNING_KEY_ID: "broken", STREAM_SIGNING_JWK: "%%%" })).status).toBe(503);
      expect(momentCount()).toBe(0);
    });

    it("skips the update when the video already requires signed URLs", async () => {
      const fetchMock = stubStream(true);
      expect((await complete()).status).toBe(201);
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    });
  });

  it("syncs in batches and follows a mode flip that happened meanwhile", async () => {
    const insert = sqlite.raw.prepare(
      "INSERT INTO moments (id, event_id, uploader_name, media_url) VALUES (?, 'ev-2', 'Sara', ?)"
    );
    for (let i = 0; i < 8; i += 1) insert.run(`b${i}`, `${HOST}/${String(i).repeat(32)}/iframe`);
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 200 });
      })
    );
    // The event is private, but the sync was asked to unlock: it must re-run as private.
    const result = await syncStreamSigning(env(), "ev-2", false);
    expect(result).toEqual({ updated: 9, failed: 0 });
    expect(bodies).toHaveLength(18);
    expect((bodies.at(-1) as { requireSignedURLs: boolean }).requireSignedURLs).toBe(true);
  });

  it("does not call Stream when a public event is re-saved as public", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const waitUntil = vi.fn();
    const ctx = { waitUntil, passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const res = await worker.fetch(
      new Request("https://moments.test/api/admin/events/ev-1/access", {
        method: "PATCH",
        headers: { Authorization: `Basic ${btoa("admin:secret")}`, "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "public" }),
      }),
      env(),
      ctx
    );
    expect(res.status).toBe(200);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-applies requireSignedURLs when an admin saves access settings", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const waitUntil = vi.fn();
    const ctx = { waitUntil, passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const res = await worker.fetch(
      new Request("https://moments.test/api/admin/events/ev-2/access", {
        method: "PATCH",
        headers: { Authorization: `Basic ${btoa("admin:secret")}`, "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "public" }),
      }),
      env(),
      ctx
    );
    expect(res.status).toBe(200);
    await Promise.all(waitUntil.mock.calls.map(([p]) => p));
    const streamCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/stream/"));
    expect(JSON.parse(String((streamCall?.[1] as RequestInit).body))).toEqual({ uid: UID, requireSignedURLs: false });
  });
});
