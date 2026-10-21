import React, { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { appActiveElement, appMount, portalMount } from "./dom-root";

let nextScreen = 0;

/** A separate full-viewport workspace, with native browser Back support. */
export function FullScreenPage({
  children,
  onClose,
  variant = "page",
}: {
  children: React.ReactNode;
  onClose: () => void;
  variant?: "page" | "modal";
}) {
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    if (variant !== "modal") return;
    const dialog = root.current;
    const content = dialog?.querySelector<HTMLElement>(".screen-content");
    if (!dialog || !content) return;

    const positionCloseButton = () => {
      const rect = content.getBoundingClientRect();
      dialog.style.setProperty(
        "--screen-modal-close-top",
        `${Math.round(rect.top + 12)}px`,
      );
      dialog.style.setProperty(
        "--screen-modal-close-right",
        `${Math.round(window.innerWidth - rect.right + 12)}px`,
      );
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(positionCloseButton);
    observer?.observe(content);
    window.addEventListener("resize", positionCloseButton);
    window.visualViewport?.addEventListener("resize", positionCloseButton);
    window.visualViewport?.addEventListener("scroll", positionCloseButton);
    positionCloseButton();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", positionCloseButton);
      window.visualViewport?.removeEventListener("resize", positionCloseButton);
      window.visualViewport?.removeEventListener("scroll", positionCloseButton);
      dialog.style.removeProperty("--screen-modal-close-top");
      dialog.style.removeProperty("--screen-modal-close-right");
    };
  }, [variant]);
  useEffect(() => {
    const previous = appActiveElement();
    const app = appMount();
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
      className={"screen-page" + (variant === "modal" ? " screen-modal" : "")}
      ref={root}
      tabIndex={-1}
      role={variant === "modal" ? "dialog" : undefined}
      aria-modal={variant === "modal" ? true : undefined}
      onClick={(e) => {
        if (variant === "modal" && e.target === e.currentTarget)
          close.current();
      }}
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
      {variant === "modal" && (
        <button
          type="button"
          className="screen-modal-close"
          onClick={() => close.current()}
          aria-label="一覧に戻る"
        >
          ✕
        </button>
      )}
      {children}
    </div>,
    portalMount(),
  );
}
