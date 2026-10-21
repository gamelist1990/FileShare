import { useNotice } from "./Toast";
import React, { useEffect, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { FullScreenPage } from "./FullScreenPage";
import { CopyButton } from "./CopyButton";
import { secureApi } from "./secure-api";
async function request(route: string, body: unknown = {}) {
  return secureApi("/api/auth/" + route, "POST", body);
}
export function PasskeyPage({
  token,
  onClose,
}: {
  token: string;
  onClose: () => void;
}) {
  const [info, setInfo] = useState<any>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [url, setURL] = useState(""),
    [done, setDone] = useState(false);
  const refresh = async () =>
    setInfo(
      await request(token ? "device/info" : "passkeys", token ? { token } : {}),
    );
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, [token]);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理できませんでした");
    } finally {
      setBusy(false);
    }
  };
  const enroll = () =>
    act(async () => {
      const opts = await request(
        "enroll/options",
        token ? { deviceToken: token } : {},
      );
      const response = await startRegistration({ optionsJSON: opts });
      await request("enroll/verify", response);
      setMessage("パスキーを追加しました。この端末でログインできます。");
      setDone(true);
      if (!token) await refresh();
    });
  useNotice(message, setMessage);
  return (
    <FullScreenPage onClose={onClose}>
      <section className="screen-content" aria-labelledby="passkey-title">
        <p className="eyebrow">PASSKEYS</p>
        <h2 id="passkey-title">
          {token ? "この端末のパスキーを登録" : "パスキー・端末の追加"}
        </h2>
        {error && <p role="alert">{error}</p>}
        {info && (
          <>
            <p>
              {token
                ? `${info.name} のアカウントにパスキーを追加します。`
                : `登録済み ${info.count} / ${info.max} 件`}
            </p>
            <p className="muted">
              同期型パスキーは複数端末で利用できます。上限は登録されたパスキーの数です。
            </p>
            {!(token && done) && (
              <button
                className="primary full"
                disabled={busy || (!token && info.count >= info.max)}
                onClick={enroll}
              >
                この端末にパスキーを追加
              </button>
            )}
            {!token && (
              <>
                <h3>別の端末に登録する</h3>
                <p>
                  登録先の端末でURLを開き、パスキーを作成してください。URLは10分間・1回限り有効です。再発行すると前のURLは無効になります。
                </p>
                <p className="muted">
                  URLを受け取った人は、あなたのアカウントへパスキーを追加できます。本人の端末だけに渡してください。
                </p>
                <button
                  disabled={busy || info.count >= info.max}
                  onClick={() =>
                    act(async () => {
                      const result = await request("device/create");
                      setURL(result.url);
                      setMessage("別端末用の登録URLを発行しました");
                    })
                  }
                >
                  別端末用の登録URLを発行
                </button>
                {url && (
                  <>
                    <label>
                      別端末用の登録URL
                      <input
                        readOnly
                        value={url}
                        onFocus={(e) => e.target.select()}
                      />
                    </label>
                    <CopyButton text={url}>登録URLをコピー</CopyButton>
                    <button
                      disabled={busy}
                      onClick={() =>
                        act(async () => {
                          await request("device/revoke");
                          setURL("");
                          setMessage("登録URLを無効にしました");
                        })
                      }
                    >
                      登録URLを無効化
                    </button>
                  </>
                )}
              </>
            )}
          </>
        )}
        {done && token && (
          <button className="primary full" onClick={onClose}>
            ログイン画面へ戻る
          </button>
        )}
      </section>
    </FullScreenPage>
  );
}
