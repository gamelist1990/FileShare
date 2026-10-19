import { loadConfig } from "./server/config";
import { createApp } from "./server/app";
if (import.meta.main) {
  const args = process.argv.slice(2),
    config = loadConfig(
      args.includes("--config")
        ? args[args.indexOf("--config") + 1]
        : undefined,
    );
  const app = await createApp(config);
  console.log(
    `PEXserver FileShare listening on ${config.host}:${config.port}; PROXY v2=${config.proxy.enabled}; origin=${config.origin}`,
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, async () => {
      await app.close();
      process.exit(0);
    });
}
