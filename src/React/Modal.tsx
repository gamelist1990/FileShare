import React, { useEffect, useRef } from "react";
let openCount = 0,
  originalOverflow = "";
export function Modal({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null),
    outside = useRef(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    if (openCount++ === 0) {
      originalOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    root.current
      ?.querySelector<HTMLElement>(
        "button,input,select,textarea,[tabindex='0']",
      )
      ?.focus({ preventScroll: true });
    return () => {
      if (--openCount === 0) document.body.style.overflow = originalOverflow;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div
      ref={root}
      className="modal-backdrop"
      onPointerDown={(e) => {
        outside.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (outside.current && e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
        if (e.key === "Tab") {
          const nodes = Array.from(
            root.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
            ) ?? [],
          ).filter((n) => n.getClientRects().length > 0);
          const first = nodes[0],
            last = nodes.at(-1);
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          }
          if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      {children}
    </div>
  );
}
