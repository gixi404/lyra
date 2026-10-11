import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  optimizeDeps: {
    include: ["react-select"],
  },
  build: {
    chunkSizeWarningLimit: 1000,
  },
}));
