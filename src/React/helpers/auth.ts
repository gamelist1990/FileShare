// ── Auth helpers ───────────────────────────────────────
export function getToken(): string | null {
  return localStorage.getItem("fs_token");
}

export function setToken(token: string) {
  localStorage.setItem("fs_token", token);
}

export function clearToken() {
  localStorage.removeItem("fs_token");
}

export function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}
