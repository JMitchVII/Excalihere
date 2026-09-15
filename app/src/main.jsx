import React from "react";
import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";
import "./styles.css";
import App from "./App.jsx";

// Serve Excalidraw fonts/assets from our own origin instead of the CDN, so the
// app works offline. Falls back to unpkg automatically if a file is missing.
window.EXCALIDRAW_ASSET_PATH = "/";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
