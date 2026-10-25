import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // Shared Windows/Docker folders do not always deliver filesystem change events.
    watch: { usePolling: true, interval: 500 },
    proxy: {
      "/api": {
        target: process.env.PAWHUB_API_PROXY_TARGET || "http://127.0.0.1:3000",
        changeOrigin: true,
      },
    },
  },
});
