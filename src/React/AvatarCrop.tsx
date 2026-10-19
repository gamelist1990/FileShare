import React, { useEffect, useRef, useState } from "react";
import { FullScreenPage } from "./FullScreenPage";
export function AvatarCrop({
  file,
  onApply,
  onClose,
}: {
  file: File;
  onApply: (image: string) => void;
  onClose: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    image = useRef<ImageBitmap | null>(null),
    drag = useRef<{ x: number; y: number; px: number; py: number } | null>(
      null,
    ),
    [zoom, setZoom] = useState(1),
    [pan, setPan] = useState({ x: 0, y: 0 }),
    [error, setError] = useState(""),
    [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    createImageBitmap(file)
      .then((b) => {
        if (!alive) {
          b.close();
          return;
        }
        image.current = b;
        setLoaded(true);
      })
      .catch(() => setError("画像を開けませんでした"));
    return () => {
      alive = false;
      image.current?.close();
    };
  }, [file]);
  useEffect(() => {
    const c = canvas.current,
      b = image.current;
    if (!c || !b) return;
    const ctx = c.getContext("2d")!,
      scale = Math.max(400 / b.width, 400 / b.height) * zoom,
      w = b.width * scale,
      h = b.height * scale;
    ctx.clearRect(0, 0, 400, 400);
    ctx.drawImage(
      b,
      (400 - w) / 2 + (Math.max(0, (w - 400) / 2) * pan.x) / 100,
      (400 - h) / 2 + (Math.max(0, (h - 400) / 2) * pan.y) / 100,
      w,
      h,
    );
  }, [zoom, pan, loaded]);
  return (
    <FullScreenPage variant="modal" onClose={onClose}>
      <section className="screen-content avatar-crop">
        <h2>アイコンの表示範囲</h2>
        <p>画像をドラッグして位置を調整できます。</p>
        <canvas
          ref={canvas}
          width={400}
          height={400}
          aria-label="アイコンの切り抜きプレビュー"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            const b = image.current;
            if (!b) return;
            const s = Math.max(400 / b.width, 400 / b.height) * zoom,
              r = e.currentTarget.getBoundingClientRect(),
              dx = ((e.clientX - drag.current.x) * 400) / r.width,
              dy = ((e.clientY - drag.current.y) * 400) / r.height;
            setPan({
              x: Math.max(
                -100,
                Math.min(
                  100,
                  drag.current.px +
                    (dx / Math.max(1, (b.width * s - 400) / 2)) * 100,
                ),
              ),
              y: Math.max(
                -100,
                Math.min(
                  100,
                  drag.current.py +
                    (dy / Math.max(1, (b.height * s - 400) / 2)) * 100,
                ),
              ),
            });
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
        />
        <label>
          拡大
          <input
            type="range"
            min="1"
            max="4"
            step=".01"
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
        </label>
        <label>
          左右の位置
          <input
            type="range"
            min="-100"
            max="100"
            value={pan.x}
            onChange={(e) => setPan({ ...pan, x: Number(e.target.value) })}
          />
        </label>
        <label>
          上下の位置
          <input
            type="range"
            min="-100"
            max="100"
            value={pan.y}
            onChange={(e) => setPan({ ...pan, y: Number(e.target.value) })}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <div className="actions">
          <button onClick={onClose}>キャンセル</button>
          <button
            className="primary"
            disabled={!loaded}
            onClick={() =>
              (() => {
                let value = canvas.current!.toDataURL("image/webp", 0.85);
                if (value.length > 350000) {
                  const small = document.createElement("canvas");
                  small.width = small.height = 192;
                  small
                    .getContext("2d")!
                    .drawImage(canvas.current!, 0, 0, 192, 192);
                  value = small.toDataURL("image/webp", 0.7);
                }
                onApply(value);
              })()
            }
          >
            この範囲を使う
          </button>
        </div>
      </section>
    </FullScreenPage>
  );
}
