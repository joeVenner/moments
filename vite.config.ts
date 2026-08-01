import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  // A service worker may only control paths at or below its own URL. Emit it
  // at the site root (not assets/) so the upload worker can use scope "/".
  worker: {
    rollupOptions: {
      output: { entryFileNames: "upload-service-worker.js" },
    },
  },
});
