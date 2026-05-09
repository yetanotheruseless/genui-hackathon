import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

// StrictMode intentionally double-invokes effects in dev. McpAppFrame's
// async bridge setup races with the cleanup of the first invocation,
// leaving iframes without an init payload. Disabled for now — re-enable
// once McpAppFrame is fully StrictMode-safe.
createRoot(document.getElementById("root")!).render(<App />);
