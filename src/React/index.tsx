import { ToastProvider } from "./Toast";
import React from "react";
import { createRoot } from "react-dom/client";
import { CommunityPage } from "./CommunityPages";
import { App } from "./App";
import { appMount } from "./dom-root";

const root = createRoot(appMount());
root.render(
  <React.StrictMode>
    <ToastProvider>
      {/^\/(rankings|search|profile|users|users\/[^/]+|files\/[a-f0-9-]{36}\/preview)$/.test(
        location.pathname,
      ) ? (
        <CommunityPage />
      ) : (
        <App />
      )}
    </ToastProvider>
  </React.StrictMode>,
);
