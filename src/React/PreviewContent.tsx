import React, { useEffect, useState, useRef } from "react";
import Markdown from "react-markdown";
import { CodeContent, codeLanguage } from "./CodeContent";
import { previewKind } from "../shared/preview";
import { CopyButton } from "./CopyButton";
export function PreviewContent({
  item,
  source,
}: {
  item: { id: string; name: string; storageState?: string };
  source?: string;
}) {
  const kind = previewKind(item.name);
  const direct = `/api/content/${item.id}`;
  const [text, setText] = useState(""),
    [notice, setNotice] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    setText("");
    setNotice("");
    if (kind === "text" || kind === "markdown")
      fetch(`/api/items/${item.id}/text`, { signal: abort.signal })
        .then(async (r) => {
          const data = await r.json();
          if (!r.ok) throw new Error(data.error);
          setText(data.text);
          if (data.truncated)
            setNotice(
              "先頭512KBを表示しています。全文はダウンロードしてください。",
            );
        })
        .catch((e) => {
          if (!abort.signal.aborted) setNotice(e.message);
        });
    return () => abort.abort();
  }, [item.id, kind]);
  const [videoSource, setVideoSource] = useState(direct),
    [videoInfo, setVideoInfo] = useState<any>(null),
    [videoBusy, setVideoBusy] = useState(false);
  const videoAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    videoAbort.current = controller;
    setVideoSource(source || direct);
    setVideoInfo(null);
    setVideoBusy(false);
    if (kind === "video")
      fetch(`/api/items/${item.id}/preview`, { signal: controller.signal })
        .then(async (r) => {
          const data = await r.json();
          if (!r.ok) throw new Error(data.error);
          if (controller.signal.aborted) return;
          setVideoInfo(data);
          if (data.state === "ready") setVideoSource(direct + "/preview");
        })
        .catch((e) => {
          if (!controller.signal.aborted) setNotice(e.message);
        });
    return () => controller.abort();
  }, [item.id, source, kind]);
  const [storageState, setStorageState] = useState(item.storageState);
  useEffect(() => {
    const controller = new AbortController();
    setStorageState(item.storageState);
    const check = () =>
      fetch(`/api/items/${item.id}`, { signal: controller.signal })
        .then(async (r) => {
          const d = await r.json();
          if (r.ok) setStorageState(d.storageState);
        })
        .catch(() => {});
    void check();
    const timer = setInterval(() => {
      if (!document.hidden) void check();
    }, 15000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [item.id, item.storageState]);
  const lightweight = async () => {
    const signal = videoAbort.current?.signal;
    if (!signal) return;
    setVideoBusy(true);
    setNotice(
      "CPUで軽量プレビューを準備しています。元の動画はそのまま再生できます。",
    );
    try {
      let r = await fetch(`/api/items/${item.id}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal,
      });
      for (let attempt = 0; attempt < 100; attempt++) {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error);
        if (data.state === "ready") {
          setVideoSource(direct + "/preview");
          setVideoInfo({ ...videoInfo, state: "ready" });
          setNotice("軽量プレビューを表示しています。");
          return;
        }
        if (data.state === "failed")
          throw new Error(data.error || "軽量プレビューを作成できませんでした");
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          }, 2000);
          const abort = () => {
            clearTimeout(timer);
            reject(new Error("中断しました"));
          };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
        r = await fetch(`/api/items/${item.id}/preview`, { signal });
      }
      throw new Error("変換中です。しばらくしてから再度開いてください。");
    } catch (e) {
      if (!signal.aborted)
        setNotice(e instanceof Error ? e.message : "変換できませんでした");
    } finally {
      if (!signal.aborted) setVideoBusy(false);
    }
  };
  const standalone = `${location.origin}/files/${item.id}/preview`;
  if (storageState === "unavailable")
    return (
      <div className="storage-error" role="status">
        <strong>404</strong>
        <h2>破損・接続不可</h2>
        <p>
          保存先ドライブまたはファイルを確認できません。再接続後、自動的に表示を再開します。
        </p>
        <button onClick={() => location.reload()}>再読み込み</button>
      </div>
    );

  return (
    <>
      {notice && <p role="status">{notice}</p>}
      {kind === "image" ? (
        <img className="preview-image" src={source || direct} alt={item.name} />
      ) : kind === "pdf" ? (
        <iframe className="pdf-preview" title={item.name} src={direct} />
      ) : kind === "video" ? (
        <div className="native-video-preview">
          <video
            key={videoSource}
            controls
            playsInline
            src={videoSource}
            preload="metadata"
            onError={() =>
              setNotice(
                "この動画を再生できない場合は、軽量プレビューを選択してください。",
              )
            }
          />
          <div className="actions">
            {videoInfo?.state === "ready" && (
              <>
                <button onClick={() => setVideoSource(direct + "/preview")}>
                  軽量プレビューで再生
                </button>
                <button onClick={() => setVideoSource(direct)}>
                  元の画質で再生
                </button>
              </>
            )}
            {videoInfo?.canCreate && videoInfo.state !== "ready" && (
              <button disabled={videoBusy} onClick={lightweight}>
                {videoBusy
                  ? "軽量化しています…"
                  : `軽量プレビューを作る（先頭${videoInfo.maxSeconds}秒）`}
              </button>
            )}
          </div>
        </div>
      ) : kind === "audio" ? (
        <audio controls src={source || direct} preload="metadata" />
      ) : kind === "markdown" ? (
        <article className="markdown-preview">
          <Markdown
            skipHtml
            components={{
              code: ({ className, children }) => (
                <CodeContent
                  text={String(children)}
                  className={className}
                  language={className?.match(/language-([^\s]+)/)?.[1]}
                />
              ),
              img: ({ alt }) => (
                <span>{alt ? `[画像: ${alt}]` : "[画像]"}</span>
              ),
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              ),
            }}
          >
            {text}
          </Markdown>
        </article>
      ) : kind === "text" ? (
        <pre className="text-preview">
          <CodeContent text={text} language={codeLanguage(item.name)} />
        </pre>
      ) : (
        <p className="muted">
          この形式はブラウザ内プレビューに対応していません。ダウンロードして開いてください。
        </p>
      )}
      <div className="preview-links">
        <CopyButton text={standalone}>プレビューURLをコピー</CopyButton>
        <CopyButton text={location.origin + direct}>
          ファイルの直リンクをコピー
        </CopyButton>
        <CopyButton
          text={`<iframe src="${standalone}" title="FileShare preview" width="100%" height="600" loading="lazy" referrerpolicy="no-referrer"></iframe>`}
        >
          埋め込みHTMLをコピー
        </CopyButton>
      </div>
      <p className="muted">
        すべてのリンクで公開範囲・閲覧権限を確認します。非公開ファイルのURLを共有しても閲覧権限は付与されません。
      </p>
    </>
  );
}
