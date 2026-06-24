import { useRef, useState } from "react";
import { compressImage } from "../lib/compressImage";

export function UploadDropzone({
  onUpload,
  uploading,
}: {
  onUpload: (file: File, caption: string) => Promise<void>;
  uploading: boolean;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setOptimizing(true);
    const optimized = await compressImage(file).finally(() => setOptimizing(false));
    await onUpload(optimized, caption);
    setFile(null);
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
          const dropped = e.dataTransfer.files?.[0];
          if (dropped) setFile(dropped);
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
          className="hidden"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <span className="font-mono text-sm text-[var(--color-accent-dark)]">
          {file ? file.name : "Tap to capture or choose a photo/video"}
        </span>
        {!file && <span className="text-xs text-slate-500">JPG, PNG, MP4 — up to 25MB</span>}
      </label>

      <input
        type="text"
        value={caption}
        onChange={(e) => setCaption(e.target.value)}
        placeholder="Add a caption (optional)"
        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />

      <button
        type="submit"
        disabled={!file || busy}
        className="rounded-lg bg-[var(--color-accent)] px-4 py-2.5 font-mono text-sm font-medium text-white transition hover:bg-[var(--color-accent-dark)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {optimizing ? "Optimizing…" : uploading ? "Uploading…" : "Share Moment"}
      </button>
    </form>
  );
}
