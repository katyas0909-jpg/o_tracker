import { DateTime } from "luxon";
import { prisma } from "../lib/db.js";

/**
 * Compose the dashboard payload for a user from the cached daily_metrics.
 * Shape mirrors what the frontend expects (per-metric daily series + a "today"
 * snapshot), so the dashboard can swap its demo SAMPLE for GET /api/dashboard.
 */

function n(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function pick(o: unknown, k: string): unknown {
  return o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
}

export async function buildDashboard(userId: number, days = 30) {
  const start = DateTime.utc().minus({ days }).toJSDate();
  const rows = await prisma.dailyMetric.findMany({
    where: { userId, day: { gte: start } },
    orderBy: { day: "asc" },
  });

  const series = {
    sleepScore: [] as { date: string; v: number }[],
    readiness: [] as { date: string; v: number }[],
    activity: [] as { date: string; v: number }[],
    hrv: [] as { date: string; v: number }[],
    rhr: [] as { date: string; v: number }[],
    temp: [] as { date: string; v: number }[],
    steps: [] as { date: string; v: number }[],
    spo2: [] as { date: string; v: number }[],
    stress: [] as { date: string; v: number }[],
    vo2: [] as { date: string; v: number }[],
  };

  const push = (
    arr: { date: string; v: number }[],
    date: string,
    v: number | null,
  ) => {
    if (v != null) arr.push({ date, v });
  };

  let latest: (typeof rows)[number] | undefined;
  for (const r of rows) {
    const date = DateTime.fromJSDate(r.day).toISODate()!;
    const sleep = r.sleep, readiness = r.readiness, activity = r.activity;
    const hr = r.heartrate, spo2 = r.spo2, temp = r.temperature;
    const stress = r.stress, cardio = r.cardio;
    push(series.sleepScore, date, n(pick(sleep, "score")));
    push(series.readiness, date, n(pick(readiness, "score")));
    push(series.activity, date, n(pick(activity, "score")));
    push(series.hrv, date, n(pick(hr, "average_hrv")));
    push(series.rhr, date, n(pick(readiness, "resting_heart_rate")) ?? n(pick(hr, "lowest_heart_rate")));
    push(series.temp, date, n(pick(temp, "deviation")));
    push(series.steps, date, n(pick(activity, "steps")));
    push(series.spo2, date, n(pick(pick(spo2, "spo2_percentage"), "average")) ?? n(pick(spo2, "average")));
    // stress_high is in seconds → minutes
    {
      const sh = n(pick(stress, "stress_high"));
      if (sh != null) series.stress.push({ date, v: Math.round(sh / 60) });
    }
    push(series.vo2, date, n(pick(cardio, "vo2_max")));
    latest = r;
  }

  // For "today", fall back to the most recent non-null value per metric so a
  // late-syncing metric (activity/heart) shows yesterday's value instead of blank.
  const desc = [...rows].reverse(); // newest first
  const latestField = (key: keyof (typeof rows)[number]): unknown => {
    for (const r of desc) {
      const v = r[key];
      if (v != null) return v;
    }
    return null;
  };

  const today = latest
    ? {
        sleep: latestField("sleep") ?? null,
        readiness: latestField("readiness") ?? null,
        activity: latestField("activity") ?? null,
        heartrate: latestField("heartrate") ?? null,
        spo2: latestField("spo2") ?? null,
        stress: latestField("stress") ?? null,
        resilience: latestField("resilience") ?? null,
        temperature: latestField("temperature") ?? null,
        cardio: latestField("cardio") ?? null,
        day: DateTime.fromJSDate(latest.day).toISODate(),
      }
    : null;

  return { date: DateTime.utc().toISODate(), series, today };
}
