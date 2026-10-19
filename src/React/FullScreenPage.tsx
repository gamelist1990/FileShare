import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

let nextScreen = 0;

/** A separate full-viewport workspace, with native browser Back support. */
export function FullScreenPage({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const app = document.getElementById("root");
    const overflow = document.body.style.overflow;
    const wasInert = app?.inert ?? false;
    const marker = `${Date.now()}:${++nextScreen}`;
    const state = history.state;
    history.pushState({ ...state, fileShareScreen: marker }, "");
    const back = () => {
      if (history.state?.fileShareScreen !== marker) close.current();
    };
    window.addEventListener("popstate", back);
    document.body.style.overflow = "hidden";
    if (app) app.inert = true;
    // Focus the page, not an input: opening a page must not summon the keyboard.
    root.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener("popstate", back);
      if (history.state?.fileShareScreen === marker) history.back();
      document.body.style.overflow = overflow;
      if (app) app.inert = wasInert;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <div
      className="screen-page"
      ref={root}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") close.current();
      }}
    >
      <header className="screen-header">
        <button onClick={() => close.current()} aria-label="一覧に戻る">
          ← 戻る
        </button>
        <span>
          PEXserver <strong>FileShare</strong>
        </span>
      </header>
      {children}
    </div>,
    document.body,
  );
}
