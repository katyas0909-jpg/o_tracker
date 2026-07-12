import cron from "node-cron";
import { DateTime } from "luxon";
import type { Bot } from "grammy";
import { prisma } from "../lib/db.js";
import { normalizeLang } from "../i18n/index.js";
import { syncUser } from "../oura/sync.js";
import { sendSummary } from "../bot/summary.js";

/**
 * Timezone-aware daily summary scheduler.
 *
 * Runs at the top of every hour. For each connected user whose LOCAL hour equals
 * their chosen summaryHour, it syncs fresh Oura data and sends the summary.
 * Sends are spread out (a few seconds apart) because everyone's Gemini
 * "observation" requests would otherwise bunch up and hit the shared free-tier
 * RPM limit.
 *
 * A per-day in-memory guard prevents double-sends within a process. (For a
 * multi-instance deployment, move this guard to a DB column.)
 */

const SEND_SPACING_MS = 5000;
const sentToday = new Map<number, string>(); // userId -> ISO date already sent

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runDueSummaries(bot: Bot): Promise<void> {
  const users = await prisma.user.findMany({ where: { ouraConnected: true } });
  const due = users.filter((u) => {
    const localNow = DateTime.utc().setZone(u.timezone);
    if (!localNow.isValid) return false;
    if (localNow.hour !== u.summaryHour) return false;
    const key = localNow.toISODate()!;
    return sentToday.get(u.id) !== key;
  });

  if (due.length === 0) return;
  console.log(`[scheduler] ${due.length} summaries due`);

  for (const u of due) {
    const lang = normalizeLang(u.language);
    const localDate = DateTime.utc().setZone(u.timezone).toISODate()!;
    try {
      await syncUser(u.id, 2);
      await sendSummary(bot, u.telegramId, u.id, lang, { withObservation: true });
      sentToday.set(u.id, localDate);
    } catch (err) {
      console.error(`[scheduler] failed for user ${u.id}:`, err);
    }
    await sleep(SEND_SPACING_MS);
  }
}

/** Periodic full re-sync so the dashboard stays fresh even without webhooks. */
async function runBackgroundSync(): Promise<void> {
  const users = await prisma.user.findMany({ where: { ouraConnected: true }, select: { id: true } });
  for (const u of users) {
    await syncUser(u.id, 7).catch(() => {});
    await sleep(1000);
  }
}

export function startScheduler(bot: Bot): void {
  // Every hour on the hour: send due daily summaries.
  cron.schedule("0 * * * *", () => {
    runDueSummaries(bot).catch((e) => console.error("[scheduler] runDueSummaries:", e));
  });

  // Every 6 hours: background re-sync of recent data.
  cron.schedule("30 */6 * * *", () => {
    runBackgroundSync().catch((e) => console.error("[scheduler] backgroundSync:", e));
  });

  // Clear the daily send guard shortly after midnight UTC.
  cron.schedule("5 0 * * *", () => sentToday.clear());

  console.log("[scheduler] started");
}
