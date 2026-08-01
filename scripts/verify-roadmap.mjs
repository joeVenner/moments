import fs from "node:fs/promises";

const base = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const lines = (await fs.readFile(".dev.vars", "utf8"))
  .split(/\r?\n/)
  .filter((line) => line && !line.trim().startsWith("#") && line.includes("="));
const vars = Object.fromEntries(lines.map((line) => {
  const index = line.indexOf("=");
  return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^(["'`])|(["'`])$/g, "")];
}));
const auth = `Basic ${Buffer.from(`${vars.ADMIN_USER}:${vars.ADMIN_PASSWORD}`).toString("base64")}`;
const admin = { Authorization: auth };
let created;

async function json(response) {
  return { response, body: await response.json().catch(() => ({})) };
}

function expectStatus(response, status, label) {
  if (response.status !== status) throw new Error(`${label}: expected ${status}, received ${response.status}`);
}

try {
  const createForm = new FormData();
  createForm.set("title", `Roadmap E2E ${Date.now()}`);
  createForm.set("type", "Party");
  let result = await json(await fetch(`${base}/api/events`, { method: "POST", headers: admin, body: createForm }));
  expectStatus(result.response, 201, "create");
  created = result.body.event;

  result = await json(await fetch(`${base}/api/admin/events/${created.id}/access`, {
    method: "PATCH",
    headers: { ...admin, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "private", pin: "4829" }),
  }));
  expectStatus(result.response, 200, "privacy");

  expectStatus(await fetch(`${base}/api/events/${created.slug}`), 401, "private gate");
  expectStatus(await fetch(`${base}/api/events/${created.slug}/access`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "0000" }),
  }), 401, "wrong PIN");
  const unlock = await fetch(`${base}/api/events/${created.slug}/access`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "4829" }),
  });
  expectStatus(unlock, 200, "correct PIN");
  const cookie = (unlock.headers.get("set-cookie") ?? "").split(";")[0];
  expectStatus(await fetch(`${base}/api/events/${created.slug}`, { headers: { Cookie: cookie } }), 200, "unlocked event");

  const upload = new FormData();
  upload.set("uploader_name", "roadmap-e2e");
  upload.set("file", new File([await fs.readFile("public/favicon.png")], "diagnostic.png", { type: "image/png" }));
  result = await json(await fetch(`${base}/api/events/${created.slug}/moments`, { method: "POST", headers: { Cookie: cookie }, body: upload }));
  expectStatus(result.response, 201, "upload");
  const momentId = result.body.moment.id;

  result = await json(await fetch(`${base}/api/events/${created.slug}/moments/${momentId}/reactions`, {
    method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ reactor_id: "roadmap-viewer" }),
  }));
  if (result.body.reaction_count !== 1) throw new Error("reaction count did not increment");
  result = await json(await fetch(`${base}/api/events/${created.slug}/highlights?reactor_id=roadmap-viewer`, { headers: { Cookie: cookie } }));
  if (result.body.moments?.[0]?.id !== momentId) throw new Error("highlight ranking did not include reacted moment");
  result = await json(await fetch(`${base}/api/admin/events/${created.slug}/analytics`, { headers: admin }));
  if (result.body.summary?.total_moments !== 1) throw new Error("analytics did not count uploaded moment");

  expectStatus(await fetch(`${base}/api/admin/moments/${momentId}`, { method: "PATCH", headers: { ...admin, "Content-Type": "application/json" }, body: JSON.stringify({ status: "hidden" }) }), 200, "hide");
  result = await json(await fetch(`${base}/api/events/${created.slug}/moments`, { headers: { Cookie: cookie } }));
  if (result.body.moments?.length !== 0) throw new Error("hidden moment remained in public feed");
  expectStatus(await fetch(`${base}/api/admin/moments/${momentId}`, { method: "PATCH", headers: { ...admin, "Content-Type": "application/json" }, body: JSON.stringify({ status: "approved" }) }), 200, "restore");
  expectStatus(await fetch(`${base}/api/admin/moments/${momentId}`, { method: "DELETE", headers: admin }), 200, "delete");

  expectStatus(await fetch(`${base}/api/admin/events/${created.id}/lifecycle`, { method: "PATCH", headers: { ...admin, "Content-Type": "application/json" }, body: JSON.stringify({ archive_now: true }) }), 200, "archive");
  expectStatus(await fetch(`${base}/api/events/${created.slug}`, { headers: { Cookie: cookie } }), 404, "archived event");
  console.log(JSON.stringify({ create: 201, privateGate: 401, unlock: 200, upload: 201, reaction: 1, highlights: 200, analytics: 200, moderation: 200, delete: 200, archive: 200 }));
} finally {
  if (created) {
    await fetch(`${base}/api/admin/events/${created.id}/lifecycle`, { method: "PATCH", headers: { ...admin, "Content-Type": "application/json" }, body: JSON.stringify({ archive_now: true }) }).catch(() => {});
  }
}
