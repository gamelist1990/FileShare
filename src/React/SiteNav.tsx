import React, { useEffect, useState } from "react";
import { secureApi } from "./secure-api";
export function SiteNav() {
  const [user, setUser] = useState<any>(null);
  useEffect(() => {
    const c = new AbortController();
    secureApi("/api/me")
      .then((d) => setUser(d.user))
      .catch(() => {});
    return () => c.abort();
  }, []);
  return (
    <header className="site-nav">
      <a className="brand" href="/">
        <img src="/server.png" alt="" />
        <span>
          <strong>PEXserver</strong>
          <small>FileShare</small>
        </span>
      </a>
      <nav aria-label="メインナビゲーション">
        {[
          ["https://pexserver.com", "Home"],
          ["/", "FileShare"],
          ["/rankings", "Ranking"],
          ["/users", "User"],
          ["/search", "Search"],
          ...(user && [1, 3, 4].includes(user.level)
            ? [["/profile", "Profile"]]
            : []),
          ...(user?.level === 4 ? [["/admin", "Admin"]] : []),
        ].map(([href, label]) => (
          <a
            key={href}
            href={href}
            aria-current={location.pathname === href ? "page" : undefined}
          >
            {label}
          </a>
        ))}
      </nav>
      {user && <span className="nav-account">{user.name}</span>}
    </header>
  );
}
