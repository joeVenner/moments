const key = "fa60290795b4f44bb333d99a718a705e";
const host = "moments-hq.com";
const base = `https://${host}`;
const urls = process.argv.slice(2).length > 0 ? process.argv.slice(2) : [`${base}/`];

for (const url of urls) {
  if (!url.startsWith(`${base}/`)) {
    throw new Error(`IndexNow URL must belong to ${host}: ${url}`);
  }
}

const response = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({
    host,
    key,
    keyLocation: `${base}/${key}.txt`,
    urlList: urls,
  }),
});

if (response.status !== 200 && response.status !== 202) {
  throw new Error(`IndexNow submission failed (${response.status}): ${await response.text()}`);
}

console.log(JSON.stringify({ status: response.status, submitted: urls }));
