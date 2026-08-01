import { useCallback, useEffect, useState } from "react";
import {
  ACTIVE_UPLOAD_STATUSES,
  deleteUpload,
  listUploads,
  subscribeToUploadChanges,
  type PersistedUpload,
} from "../lib/uploadStore";
import { cancelResumableUpload, retryResumableUpload } from "../lib/multipartUpload";
import { useI18n } from "../lib/i18n";
import uploadCompleteArt from "../assets/illustrations/upload-complete.webp";

function percent(upload: PersistedUpload): number {
  if (upload.status === "completed") return 100;
  if (upload.fileSize <= 0) return 0;
  return Math.min(99, Math.round(((upload.loadedBytes ?? 0) / upload.fileSize) * 100));
}

function percentLabel(upload: PersistedUpload, value: number): string {
  if ((upload.loadedBytes ?? 0) > 0 && value === 0) return "<1%";
  return `${value}%`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function UploadManager({ slug }: { slug: string }) {
  const { t } = useI18n();
  const [uploads, setUploads] = useState<PersistedUpload[]>([]);

  const refresh = useCallback(async () => {
    const rows = await listUploads(slug);
    setUploads(rows.sort((a, b) => b.createdAt - a.createdAt));
  }, [slug]);

  useEffect(() => {
    void refresh();
    return subscribeToUploadChanges(() => void refresh());
  }, [refresh]);

  if (uploads.length === 0) return null;
  const allCompleted = uploads.every((upload) => upload.status === "completed");

  return (
    <section className="mt-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-mono text-xs font-semibold uppercase tracking-wide text-[var(--color-text)]">
          {t("uploadManagerTitle")}
        </h2>
        {uploads.some((upload) => upload.status === "completed") && (
          <button
            type="button"
            onClick={() =>
              void Promise.all(
                uploads.filter((upload) => upload.status === "completed").map((upload) => deleteUpload(upload.id))
              )
            }
            className="font-mono text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
          >
            {t("clearCompleted")}
          </button>
        )}
      </div>

      <ul className="space-y-2">
        {uploads.map((upload) => {
          const progress = percent(upload);
          const retryable = upload.status === "paused" || upload.status === "failed";
          const active = ACTIVE_UPLOAD_STATUSES.has(upload.status);
          return (
            <li key={upload.id} className="rounded-lg border border-[var(--color-border)] p-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-[var(--color-text)]">{upload.fileName}</p>
                  <p className="mt-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">
                    {t(`uploadStatus_${upload.status}`)} · {formatBytes(upload.fileSize)}
                  </p>
                </div>
                <span className="font-mono text-xs text-[var(--color-text-muted)]">
                  {percentLabel(upload, progress)}
                </span>
              </div>

              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-border)]">
                <div
                  className={`h-full rounded-full transition-[width] duration-200 ${
                    upload.status === "completed" ? "bg-emerald-500" : "bg-[var(--color-accent)]"
                  }`}
                  style={{ width: `${Math.max(progress, (upload.loadedBytes ?? 0) > 0 ? 1 : 0)}%` }}
                />
              </div>

              {upload.lastError && (upload.status === "paused" || upload.status === "failed") && (
                <p className="mt-1.5 truncate text-[11px] text-red-400">{upload.lastError}</p>
              )}

              <div className="mt-2 flex justify-end gap-3">
                {retryable && (
                  <button
                    type="button"
                    onClick={() => void retryResumableUpload(upload)}
                    className="font-mono text-xs text-[var(--color-accent)]"
                  >
                    {t("retryUpload")}
                  </button>
                )}
                {active && upload.status !== "completed" && (
                  <button
                    type="button"
                    onClick={() => {
                      if (upload.backend === "stream") {
                        void import("../lib/streamUpload").then(({ cancelStreamUpload }) =>
                          cancelStreamUpload(upload)
                        );
                      } else {
                        void cancelResumableUpload(upload);
                      }
                    }}
                    className="font-mono text-xs text-red-400"
                  >
                    {t("cancelUpload")}
                  </button>
                )}
                {upload.status === "completed" && (
                  <button
                    type="button"
                    onClick={() => void deleteUpload(upload.id)}
                    className="font-mono text-xs text-[var(--color-text-muted)]"
                  >
                    {t("dismissUpload")}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {allCompleted && (
        <div className="mt-3 flex items-center gap-3 overflow-hidden rounded-lg border border-emerald-900/40 bg-[var(--color-bg)] p-2">
          <img src={uploadCompleteArt} alt="" className="h-16 w-16 rounded-md object-cover" />
          <div><p className="text-sm font-medium text-[var(--color-text)]">{t("allUploadsComplete")}</p><p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{t("uploadsSafeHint")}</p></div>
        </div>
      )}
    </section>
  );
}
