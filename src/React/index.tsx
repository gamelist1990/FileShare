import React from "react";
import { createRoot } from "react-dom/client";
import { CommunityPage } from "./CommunityPages";
import { App } from "./App";

const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    {/^\/(rankings|profile|users\/[^/]+|files\/[a-f0-9-]{36}\/preview)$/.test(
      location.pathname,
    ) ? (
      <CommunityPage />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
