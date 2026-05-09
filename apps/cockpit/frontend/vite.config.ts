import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const BACKEND = process.env.BACKEND ?? "http://localhost:4040";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: 5174,
    proxy: {
      "/api":  { target: BACKEND, changeOrigin: true },
      "/ws":   { target: BACKEND, changeOrigin: true, ws: true },
      "/ui":   { target: BACKEND, changeOrigin: true },
      "/tool": { target: BACKEND, changeOrigin: true },
    },
  },
});
