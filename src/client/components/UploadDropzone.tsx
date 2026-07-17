import { useRef, useState } from "react";
import { compressImage } from "../lib/compressImage";
import { canTranscodeVideo } from "../lib/optimizeDetect";
import { useI18n } from "../lib/i18n";

const OPTIMIZE_KEY = "moments:optimize_uploads";

export function UploadDropzone({
  onUpload,
  uploading,
}: {
  onUpload: (files: File[], caption: string, opts?: { optimize?: boolean }) => Promise<void>;
  uploading: boolean;
}) {
  const { t } = useI18n();
  const [files, setFiles] = useState<File[]>([]);
  const [caption, setCaption] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  // Opt-in video transcode (default off). Needs WebCodecs, so the checkbox is
  // hidden entirely where it can't run — no dead control. See lib/optimizeVideo.ts.
  const supportsOptimize = canTranscodeVideo();
  const [optimize, setOptimize] = useState(
    () => (typeof localStorage !== "undefined" && localStorage.getItem(OPTIMIZE_KEY) === "1") || false
  );
  const inputRef = useRef<HTMLInputElement>(null);

  function toggleOptimize(next: boolean) {
    setOptimize(next);
    try {
      localStorage.setItem(OPTIMIZE_KEY, next ? "1" : "0");
    } catch {
      // Private mode etc. — the toggle still works for this session.
    }
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (files.length === 0) return;
    setOptimizing(true);
    const optimized = await Promise.all(files.map((f) => compressImage(f))).finally(() =>
      setOptimizing(false)
    );
    await onUpload(optimized, caption, { optimize });
    setFiles([]);
    setCaption("");
    if (inputRef.current) inputRef.current.value = "";
  }

  const busy = optimizing || uploading;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) setFiles(Array.from(e.dataTransfer.files));
        }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition ${
          dragOver
            ? "border-[var(--color-accent)] bg-[var(--color-bg-alt)]"
            : "border-[var(--color-border)] bg-[var(--color-bg-alt)]"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*,video/*"
          multiple
          className="hidden"
          onChange={(e) => setFiles(e.target.files ? Array.from(e.target.files) : [])}
        />
        <span className="font-mono text-sm text-[var(--color-accent-dark)]">
          {files.length > 0 ? t("filesSelected", { count: files.length }) : t("tapToChoose")}
        </span>
        {files.length === 0 && <span className="text-xs text-[var(--color-text-muted)]">{t("uploadHint")}</span>}
      </label>

      {files.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${f.lastModified}-${i}`}
              className="flex items-center justify-between rounded-lg bg-[var(--color-bg-alt)] px-3 py-2 text-sm"
            >
              <span className="truncate text-[var(--color-text)]">{f.name}</span>
              <button
                type="button"
                onClick={() => removeFile(i)}
                aria-label={t("removeFile", { name: f.name })}
                className="ml-2 shrink-0 font-mono text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent-dark)]"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <input
        type="text"
        value={caption}
        onChange={(e) => setCaption(e.target.value)}
        placeholder={t("addCaptionPlaceholder")}
        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-3 text-base outline-none focus:border-[var(--color-accent)]"
      />

      {supportsOptimize && (
        <label className="flex items-center gap-2 font-mono text-xs text-[var(--color-text-muted)]">
          <input
            type="checkbox"
            checked={optimize}
            onChange={(e) => toggleOptimize(e.target.checked)}
            disabled={busy}
            className="h-3.5 w-3.5 accent-[var(--color-accent)]"
          />
          {t("optimizeVideos")}
        </label>
      )}

      <button
        type="submit"
        disabled={files.length === 0 || busy}
        className="rounded-lg bg-[var(--color-accent)] px-4 py-2.5 font-mono text-sm font-medium text-white transition hover:bg-[var(--color-accent-dark)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {optimizing
          ? t("optimizing")
          : uploading
            ? t("uploading")
            : t("shareMoment", { count: files.length })}
      </button>
    </form>
  );
}
