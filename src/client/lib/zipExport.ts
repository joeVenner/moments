import type { MomentData } from "./types";

export function safeArchiveName(value: string): string {
  return value.normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70) || "moment";
}

function extension(moment: MomentData): string {
  const byType: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/heic": "heic",
    "image/heif": "heif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
  };
  return byType[moment.mime_type ?? ""] ?? "bin";
}

export async function downloadMomentsZip(title: string, moments: MomentData[]): Promise<void> {
  const { Zip, ZipPassThrough, strToU8 } = await import("fflate");
  const chunks: ArrayBuffer[] = [];
  const completed = new Promise<Blob>((resolve, reject) => {
    const zip = new Zip((error, data, final) => {
      if (error) {
        reject(error);
        return;
      }
      chunks.push(new Uint8Array(data).buffer);
      if (final) resolve(new Blob(chunks, { type: "application/zip" }));
    });

    void (async () => {
      const manifest = moments.map((moment) => ({
        id: moment.id,
        uploader: moment.uploader_name,
        caption: moment.caption,
        created_at: moment.created_at,
        // Drop the admin view token (?mv=...): the archive outlives it.
        media_url: moment.media_url.split("?")[0],
      }));
      const manifestEntry = new ZipPassThrough("moments.json");
      zip.add(manifestEntry);
      manifestEntry.push(strToU8(JSON.stringify(manifest, null, 2)), true);

      for (const [index, moment] of moments.entries()) {
        if (!moment.media_url.startsWith("/media/")) continue;
        const response = await fetch(moment.media_url);
        if (!response.ok) throw new Error(`Unable to download moment ${moment.id}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const name = `${String(index + 1).padStart(3, "0")}-${safeArchiveName(moment.uploader_name)}-${moment.id.slice(0, 8)}.${extension(moment)}`;
        const entry = new ZipPassThrough(name);
        zip.add(entry);
        entry.push(bytes, true);
      }
      zip.end();
    })().catch(reject);
  });

  const blob = await completed;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeArchiveName(title)}-moments.zip`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
