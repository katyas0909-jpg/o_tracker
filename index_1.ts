import { config, TELEGRAM_WEBHOOK_PATH } from "./config.js";
import { createBot } from "./bot/index.js";
import { buildServer } from "./server/app.js";
import { startScheduler } from "./scheduler/index.js";
import { disconnectDb } from "./lib/db.js";

async function main(): Promise<void> {
  const bot = createBot();
  await bot.init();

  // Register the command menu (best-effort).
  await bot.api
    .setMyCommands([
      { command: "today", description: "Today's summary" },
      { command: "week", description: "Weekly overview" },
      { command: "connect", description: "Connect / reconnect Oura" },
      { command: "settings", description: "Language, timezone, summary time" },
      { command: "language", description: "Change language" },
      { command: "help", description: "Help" },
    ])
    .catch((e) => console.error("[boot] setMyCommands:", e));

  const app = await buildServer(bot as never);

  // Point Telegram at our webhook.
  const webhookUrl = `${config.PUBLIC_URL}${TELEGRAM_WEBHOOK_PATH}`;
  await bot.api.setWebhook(webhookUrl, {
    secret_token: config.TELEGRAM_WEBHOOK_SECRET,
    // Drop any backlog that piled up while the free instance was asleep, so a
    // redeploy doesn't flush a burst of old/duplicate messages.
    drop_pending_updates: true,
  });
  console.log(`[boot] webhook set: ${config.PUBLIC_URL}${TELEGRAM_WEBHOOK_PATH.replace(config.TELEGRAM_WEBHOOK_SECRET, "***")}`);

  startScheduler(bot as never);

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  console.log(`[boot] O Tracker listening on :${config.PORT} (${config.NODE_ENV})`);

  const shutdown = async (sig: string) => {
    console.log(`[shutdown] ${sig}`);
    try {
      await app.close();
      await disconnectDb();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal boot error:", err);
  process.exit(1);
});
