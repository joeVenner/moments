import { useRef, useState } from "react";
import { compressImage } from "../lib/compressImage";
import { useI18n } from "../lib/i18n";

export function UploadDropzone({
  onUpload,
  uploading,
}: {
  onUpload: (files: File[], caption: string) => Promise<void>;
  uploading: boolean;
}) {
  const { t } = useI18n();
  const [files, setFiles] = useState<File[]>([]);
  const [caption, setCaption] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
    await onUpload(optimized, caption);
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
            : "border-slate-300 bg-[var(--color-bg-alt)]"
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
        {files.length === 0 && <span className="text-xs text-slate-500">{t("uploadHint")}</span>}
      </label>

      {files.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${f.lastModified}-${i}`}
              className="flex items-center justify-between rounded-lg bg-white px-3 py-2 text-sm"
            >
              <span className="truncate text-slate-700">{f.name}</span>
              <button
                type="button"
                onClick={() => removeFile(i)}
                aria-label={t("removeFile", { name: f.name })}
                className="ml-2 shrink-0 font-mono text-xs text-slate-400 hover:text-[var(--color-accent-dark)]"
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
        className="rounded-lg border border-slate-300 bg-white px-3 py-3 text-base outline-none focus:border-[var(--color-accent)]"
      />

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
