import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { PUBLIC_PATHS } from "../worker/src/public-paths";

// In development, the Worker runs on port 8787 (`pnpm dev` in worker/).
const worker = "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: Object.fromEntries(
      ["/api", ...PUBLIC_PATHS].map((p) => [p, worker]),
    ),
  },
});
