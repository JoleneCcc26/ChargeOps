import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite dev server proxies /api → Express (port 4000).
// This means:
//   - no CORS issues
//   - frontend works regardless of which Vite port (5173/5174/etc.) is picked
//   - VITE_API_URL can stay as "/api" in .env
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
