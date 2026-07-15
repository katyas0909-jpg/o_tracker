import { DateTime } from "luxon";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { prisma } from "../lib/db.js";
import { config } from "../config.js";
import { t, type Lang } from "../i18n/index.js";
import { summaryObservation } from "../gemini/assistant.js";

const LOCALE: Record<Lang, string> = { ru: "ru", en: "en", pt: "pt" };

function pick(o: unknown, k: string): unknown {
  return o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
}
function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
function fmtSleepDuration(sec: number | null, lang: Lang): string {
  if (sec == null) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return lang === "ru" ? `${h}ч ${m}м` : `${h}h ${String(m).padStart(2, "0")}m`;
}

export interface ComposedSummary {
  text: string;
  keyboard: InlineKeyboard;
  hasData: boolean;
}

export async function composeSummary(
  userId: number,
  lang: Lang,
  opts: { withObservation?: boolean } = {},
): Promise<ComposedSummary> {
  // Pull recent days so we can fall back to the latest available value per metric
  // (activity/heart finalize later than sleep, so today's row may still be empty).
  const rows = await prisma.dailyMetric.findMany({
    where: { userId },
    orderBy: { day: "desc" },
    take: 10,
  });

  const dashUrl = `${config.PUBLIC_URL}/`;
  const keyboard = new InlineKeyboard().url(t(lang, "summary.openDashboard"), dashUrl);

  if (rows.length === 0) {
    return { text: t(lang, "summary.noData"), keyboard, hasData: false };
  }

  const latest = rows[0]!;
  // Most recent non-null value of a metric field across the recent days.
  const latestObj = (key: string): unknown => {
    for (const r of rows) {
      const v = (r as Record<string, unknown>)[key];
      if (v != null) return v;
    }
    return null;
  };
  const sleepObj = latestObj("sleep");
  const readinessObj = latestObj("readiness");
  const activityObj = latestObj("activity");

  const dateStr = DateTime.fromJSDate(latest.day)
    .setLocale(LOCALE[lang])
    .toLocaleString({ weekday: "long", day: "numeric", month: "long" });

  const sleepScore = num(pick(sleepObj, "score"));
  const totalSleep = num(pick(sleepObj, "total_sleep_duration"));
  const readiness = num(pick(readinessObj, "score"));
  const activityScore = num(pick(activityObj, "score"));
  const steps = num(pick(activityObj, "steps"));

  const lines = [
    t(lang, "summary.title", { date: dateStr }),
    "",
    t(lang, "summary.sleep", {
      score: sleepScore ?? "—",
      dur: fmtSleepDuration(totalSleep, lang),
    }),
    t(lang, "summary.readiness", { score: readiness ?? "—" }),
    t(lang, "summary.activity", {
      score: activityScore ?? "—",
      steps: steps != null ? steps.toLocaleString(LOCALE[lang]) : "—",
    }),
  ];

  if (opts.withObservation) {
    const obs = await summaryObservation(userId, lang);
    if (obs) lines.push("", `✦ ${obs}`);
  }

  return { text: lines.join("\n"), keyboard, hasData: true };
}

/** Send the daily summary to a user (used by the scheduler and /today). */
export async function sendSummary(
  bot: Bot,
  telegramId: bigint,
  userId: number,
  lang: Lang,
  opts: { withObservation?: boolean } = {},
): Promise<void> {
  const { text, keyboard } = await composeSummary(userId, lang, opts);
  await bot.api.sendMessage(telegramId.toString(), text, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
    link_preview_options: { is_disabled: true },
  });
}
