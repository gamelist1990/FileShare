import type { Store } from "./store";
export function startMonitor(store: Store) {
  if (!store.config.ai.enabled) return () => {};
  let active = false;
  const run = async () => {
    if (active) return;
    active = true;
    try {
      // Only bounded numeric aggregates leave the service. AI cannot run commands or alter ACLs.
      const rows = store.db
        .query(
          "SELECT action,count(*) AS count FROM audit WHERE time>? GROUP BY action ORDER BY count DESC LIMIT 20",
        )
        .all(Date.now() - 600_000);
      const response = await fetch(store.config.ai.endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "Content-Type": "application/json",
          ...(process.env.FILESHARE_AI_KEY
            ? { Authorization: "Bearer " + process.env.FILESHARE_AI_KEY }
            : {}),
        },
        body: JSON.stringify({
          model: store.config.ai.model,
          messages: [
            {
              role: "system",
              content:
                "You are a security monitoring assistant. Analyze numeric event counts only. Return a short Japanese advisory with suspected abuse patterns. No commands, no automatic enforcement, do not claim malicious activity is proven.",
            },
            {
              role: "user",
              content: JSON.stringify({ windowMinutes: 10, events: rows }),
            },
          ],
          max_tokens: 400,
          temperature: 0.1,
        }),
      });
      if (!response.ok) throw new Error("AI HTTP " + response.status);
      const data = (await response.json()) as any;
      const report = String(data.choices?.[0]?.message?.content ?? "").slice(
        0,
        8000,
      );
      if (report)
        store.db.run("INSERT INTO ai_reports(time,report) VALUES (?,?)", [
          Date.now(),
          report,
        ]);
      store.db.run(
        "DELETE FROM ai_reports WHERE id NOT IN (SELECT id FROM ai_reports ORDER BY id DESC LIMIT 100)",
      );
    } catch (e) {
      store.audit(
        "local",
        null,
        "ai.error",
        e instanceof Error ? e.message : "AI unavailable",
      );
    } finally {
      active = false;
    }
  };
  const timer = setInterval(
    run,
    Math.max(60, store.config.ai.intervalSeconds) * 1000,
  );
  timer.unref();
  return () => clearInterval(timer);
}
