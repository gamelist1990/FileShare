import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { portalMount } from "./dom-root";
type Tone = "success" | "error";
type Toast = { id: number; text: string; tone: Tone };
const ToastContext = createContext<(text: string, tone?: Tone) => void>(
  () => {},
);
export const useNotify = () => useContext(ToastContext);
/** Consume transient state once; persistent instructions and secrets stay in their own UI. */
export function useNotice(
  text: string,
  clear: (value: string) => void,
  tone: Tone = "success",
) {
  const notify = useNotify();
  useEffect(() => {
    if (text) {
      notify(text, tone);
      clear("");
    }
  }, [text, clear, notify, tone]);
}
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const sequence = useRef(0);
  const notify = useCallback((text: string, tone: Tone = "success") => {
    const next = { id: ++sequence.current, text, tone };
    setToasts((current) =>
      [...current.filter((t) => t.text !== text), next].slice(-3),
    );
  }, []);
  const dismiss = useCallback(
    (id: number) => setToasts((current) => current.filter((t) => t.id !== id)),
    [],
  );
  return (
    <ToastContext.Provider value={notify}>
      {children}
      {createPortal(
        <aside className="toast-stack" aria-label="通知">
          {toasts.map((toast) => (
            <ToastCard key={toast.id} toast={toast} dismiss={dismiss} />
          ))}
        </aside>,
        portalMount(),
      )}
    </ToastContext.Provider>
  );
}
function ToastCard({
  toast,
  dismiss,
}: {
  toast: Toast;
  dismiss: (id: number) => void;
}) {
  const [hovered, setHovered] = useState(false),
    [focused, setFocused] = useState(false),
    [closing, setClosing] = useState(false);
  const remaining = useRef(toast.tone === "error" ? 8000 : 4000);
  const paused = hovered || focused;
  useEffect(() => {
    if (closing) {
      const timer = setTimeout(() => dismiss(toast.id), 220);
      return () => clearTimeout(timer);
    }
    if (paused) return;
    const started = performance.now();
    const timer = setTimeout(() => setClosing(true), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(
        0,
        remaining.current - (performance.now() - started),
      );
    };
  }, [paused, closing, dismiss, toast.id]);
  return (
    <div
      className={`toast toast-${toast.tone}${closing ? " toast-leaving" : ""}${paused ? " toast-paused" : ""}`}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setFocused(false);
      }}
    >
      <span className="toast-icon" aria-hidden="true">
        {toast.tone === "error" ? "!" : "✓"}
      </span>
      <span
        className="toast-text"
        role={toast.tone === "error" ? "alert" : "status"}
        aria-atomic="true"
      >
        {toast.text}
      </span>
      <button
        type="button"
        className="toast-dismiss"
        aria-label="通知を閉じる"
        onClick={() => setClosing(true)}
      >
        ×
      </button>
      <span className="toast-progress" aria-hidden="true" />
    </div>
  );
}
