import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * Generates a branded QR code data URL for a guest-facing event URL.
 * Shared by QRPanel (small on-screen preview) and QRFlyer (printable flyer)
 * so both render the exact same real, scannable QR code.
 */
export function useQrDataUrl(url: string): string | null {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(url, {
      // Rendered on-screen at ~144px but sourced at a higher resolution so the
      // printed flyer (A6) stays crisp and reliably scannable from paper.
      width: 600,
      margin: 2,
      color: { dark: "#C15F3C", light: "#FCFAF6" },
    }).then((result) => {
      if (!cancelled) setDataUrl(result);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return dataUrl;
}
