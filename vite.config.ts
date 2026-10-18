import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2022",
    rollupOptions: {
      // pad.html is the page a tablet opens to draw on a board (src/pad); the app serves it
      // from its own build (src-tauri/src/pad.rs), so it is built beside the editor.
      input: { main: "index.html", pad: "pad.html" },
    },
  },
});
