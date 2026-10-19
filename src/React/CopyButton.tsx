import React, { useState } from "react";

/** Keep the copy attempt inside the click gesture, including older/mobile browsers. */
export function CopyButton({
  text,
  children,
}: {
  text: string;
  children: React.ReactNode;
}) {
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <div className="copy-control">
      <button
        type="button"
        disabled={pending}
        onClick={async (event) => {
          const button = event.currentTarget;
          const field = button
            .closest(".copy-control")
            ?.previousElementSibling?.querySelector<HTMLInputElement>("input");
          setPending(true);
          setStatus("");
          let copied = false;
          // execCommand works during the original tap even where Clipboard API is unavailable.
          const helper = document.createElement("textarea");
          helper.value = text;
          helper.readOnly = true;
          helper.style.cssText =
            "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px";
          document.body.appendChild(helper);
          const previous = document.activeElement as HTMLElement | null;
          try {
            helper.focus({ preventScroll: true });
            helper.select();
            helper.setSelectionRange(0, text.length);
            copied = document.execCommand("copy");
          } catch {
            /* Try the standards API next. */
          } finally {
            helper.remove();
            previous?.focus({ preventScroll: true });
          }
          try {
            if (navigator.clipboard?.writeText) {
              await navigator.clipboard.writeText(text);
              copied = true;
            }
          } catch {
            /* A selected URL remains available for manual copying. */
          }
          if (copied) setStatus("コピーしました");
          else {
            field?.focus();
            field?.select();
            field?.setSelectionRange(0, text.length);
            setStatus(
              "自動コピーできませんでした。URL欄を長押し、または Ctrl+C / ⌘C でコピーしてください。",
            );
          }
          setPending(false);
        }}
      >
        {children}
      </button>
      {status && (
        <p role="status" className="copy-status">
          {status}
        </p>
      )}
    </div>
  );
}
