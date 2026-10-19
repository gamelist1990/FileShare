import type { Store } from "./store";
export function startMonitor(store: Store) {
  let active = false,
    disposed = false,
    lastRun = Date.now();
  let fingerprint = JSON.stringify(store.config.ai);
  let controller: AbortController | null = null;
  const run = async () => {
    if (active || disposed || !store.config.ai.enabled) return;
    active = true;
    const settings = { ...store.config.ai },
      runFingerprint = JSON.stringify(settings);
    controller = new AbortController();
    try {
      // Only bounded numeric aggregates leave the service. AI cannot run commands or alter ACLs.
      const rows = store.db
        .query(
          "SELECT action,count(*) AS count FROM audit WHERE time>? GROUP BY action ORDER BY count DESC LIMIT 20",
        )
        .all(Date.now() - 600_000);
      const response = await fetch(settings.endpoint, {
        method: "POST",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(30_000),
        ]),
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.FILESHARE_AI_KEY
            ? { Authorization: "Bearer " + process.env.FILESHARE_AI_KEY }
            : {}),
        },
        body: JSON.stringify({
          model: settings.model,
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
      if (
        disposed ||
        !store.config.ai.enabled ||
        runFingerprint !== JSON.stringify(store.config.ai)
      )
        return;
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
      if (disposed || controller?.signal.aborted) return;
      store.audit(
        "local",
        null,
        "ai.error",
        e instanceof Error ? e.message : "AI unavailable",
      );
    } finally {
      active = false;
      controller = null;
    }
  };
  const timer = setInterval(() => {
    const current = JSON.stringify(store.config.ai);
    if (current !== fingerprint) {
      fingerprint = current;
      controller?.abort();
      lastRun = store.config.ai.enabled ? 0 : Date.now();
    }
    if (
      store.config.ai.enabled &&
      !active &&
      Date.now() - lastRun >=
        Math.max(60, store.config.ai.intervalSeconds) * 1000
    ) {
      lastRun = Date.now();
      void run();
    }
  }, 1000);
  timer.unref();
  return () => {
    disposed = true;
    clearInterval(timer);
    controller?.abort();
  };
}
