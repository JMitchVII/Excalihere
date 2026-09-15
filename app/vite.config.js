import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    // @excalidraw/excalidraw reads this at module scope.
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  server: {
    port: 5178,
    // File System Access permissions are scoped to the origin, so silently
    // falling back to 5179 would orphan every linked file. Fail loudly instead
    // (the service uses this port too - stop it before running dev).
    strictPort: true,
    open: true,
  },
});
