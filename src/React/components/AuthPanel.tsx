import React, { useState } from "react";
import { Icon } from "./Icon";
import { setToken } from "../helpers/auth";

// ── Auth Panel Component ───────────────────────────────
export function AuthPanel({
  onLogin,
}: {
  onLogin: (username: string) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (data.ok && data.token) {
        setToken(data.token);
        onLogin(data.username ?? username);
      }
      setMsg({ text: data.message, ok: !!data.ok });
    } catch {
      setMsg({ text: "通信エラー", ok: false });
    } finally {
      setBusy(false);
    }
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") submit();
  };

  return (
    <div style={authStyles.panel}>
      <div style={authStyles.tabs}>
        <button
          style={mode === "login" ? authStyles.tabActive : authStyles.tab}
          onClick={() => { setMode("login"); setMsg(null); }}
        >
          <Icon name="fa-solid fa-right-to-bracket" style={{ marginRight: 6 }} />
          ログイン
        </button>
        <button
          style={mode === "register" ? authStyles.tabActive : authStyles.tab}
          onClick={() => { setMode("register"); setMsg(null); }}
        >
          <Icon name="fa-solid fa-user-plus" style={{ marginRight: 6 }} />
          新規登録
        </button>
      </div>
      <input
        style={authStyles.input}
        placeholder="ユーザー名"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        onKeyDown={handleKey}
        autoFocus
      />
      <input
        style={authStyles.input}
        type="password"
        placeholder="パスワード"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={handleKey}
      />
      <button style={authStyles.submit} onClick={submit} disabled={busy}>
        {busy ? (
          <><Icon name="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }} />処理中...</>
        ) : mode === "login" ? (
          <><Icon name="fa-solid fa-right-to-bracket" style={{ marginRight: 6 }} />ログイン</>
        ) : (
          <><Icon name="fa-solid fa-paper-plane" style={{ marginRight: 6 }} />登録リクエスト送信</>
        )}
      </button>
      {msg && (
        <div style={{ ...authStyles.msg, color: msg.ok ? "#27ae60" : "#c0392b" }}>
          <Icon name={msg.ok ? "fa-solid fa-circle-check" : "fa-solid fa-circle-xmark"} style={{ marginRight: 6 }} />
          {msg.text}
        </div>
      )}
    </div>
  );
}

export const authStyles: Record<string, React.CSSProperties> = {
  panel: {
    maxWidth: 360,
    margin: "48px auto",
    padding: 24,
    background: "#f8f9fa",
    borderRadius: 12,
    border: "1px solid #ddd",
  },
  tabs: { display: "flex", gap: 4, marginBottom: 16 },
  tab: {
    flex: 1,
    padding: "8px 0",
    border: "1px solid #ccc",
    borderRadius: 6,
    background: "#fff",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 500,
    color: "#555",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  tabActive: {
    flex: 1,
    padding: "8px 0",
    border: "2px solid #3366cc",
    borderRadius: 6,
    background: "#eef3ff",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 600,
    color: "#3366cc",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  input: {
    display: "block",
    width: "100%",
    padding: "10px 12px",
    marginBottom: 10,
    border: "1px solid #ccc",
    borderRadius: 6,
    fontSize: 14,
    boxSizing: "border-box",
    fontFamily: "inherit",
  },
  submit: {
    width: "100%",
    padding: "10px 0",
    border: "none",
    borderRadius: 6,
    background: "#3366cc",
    color: "#fff",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  msg: { marginTop: 12, fontSize: 13, textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center" },
};
