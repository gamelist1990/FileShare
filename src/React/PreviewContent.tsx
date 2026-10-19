import React, { useEffect, useState } from "react";
import Markdown from "react-markdown";
import { previewKind } from "../shared/preview";
import { CopyButton } from "./CopyButton";
export function PreviewContent({
  item,
  source,
}: {
  item: { id: string; name: string };
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
  const standalone = `${location.origin}/files/${item.id}/preview`;
  return (
    <>
      {notice && <p role="status">{notice}</p>}
      {kind === "image" ? (
        <img className="preview-image" src={source || direct} alt={item.name} />
      ) : kind === "pdf" ? (
        <iframe className="pdf-preview" title={item.name} src={direct} />
      ) : kind === "video" ? (
        <video controls src={source || direct} preload="metadata" />
      ) : kind === "audio" ? (
        <audio controls src={source || direct} preload="metadata" />
      ) : kind === "markdown" ? (
        <article className="markdown-preview">
          <Markdown
            skipHtml
            components={{
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
          <code>{text}</code>
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
