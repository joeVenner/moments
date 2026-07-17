const MAX_DIMENSION = 1920;
const JPEG_QUALITY = 0.82;
const SKIP_BELOW_BYTES = 1.5 * 1024 * 1024;

export async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.size < SKIP_BELOW_BYTES) {
    return file;
  }

  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1) {
      bitmap.close();
      return file;
    }

    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const outputType = file.type === "image/png" ? "image/png" : "image/jpeg";
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, outputType, JPEG_QUALITY)
    );
    if (!blob || blob.size >= file.size) return file;

    const newName = file.name.replace(/\.\w+$/, outputType === "image/png" ? ".png" : ".jpg");
    return new File([blob], newName, { type: outputType });
  } catch {
    return file; // unsupported format (e.g. some HEIC variants) — upload original
  }
}
