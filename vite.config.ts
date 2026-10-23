import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { workspacePolicy } from "./src/shared/security.js";
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist/web" },
  server: {
    host: "127.0.0.1",
    port: 5173,
    headers: {
      "Content-Security-Policy": workspacePolicy(),
    },
    proxy: { "/api": "http://127.0.0.1:4310" },
  },
});
