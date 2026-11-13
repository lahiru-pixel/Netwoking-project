import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    hmr: false,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4000",
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyRequest, request) => {
            if (request.headers.host) {
              proxyRequest.setHeader("x-forwarded-host", request.headers.host);
            }
          });
        },
      },
    },
  },
});
