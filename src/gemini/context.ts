import { DateTime } from "luxon";
import { prisma } from "../lib/db.js";

/**
 * Build a compact JSON context of a user's recent metrics for the LLM.
 * We extract only the fields that matter and round them, to keep the prompt
 * small (cost + latency) and avoid dumping raw Oura payloads.
 */

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
}
function pick(obj: unknown, key: string): unknown {
  return obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
}

export interface DayContext {
  day: string;
  sleepScore: number | null;
  totalSleepH: number | null;
  readiness: number | null;
  activityScore: number | null;
  steps: number | null;
  restingHr: number | null;
  hrv: number | null;
  tempDeviation: number | null;
  spo2: number | null;
  stressHigh: number | null;
  resilience: string | null;
}

export async function buildMetricContext(userId: number, days: number): Promise<DayContext[]> {
  const start = DateTime.utc().minus({ days }).toJSDate();
  const rows = await prisma.dailyMetric.findMany({
    where: { userId, day: { gte: start } },
    orderBy: { day: "asc" },
  });

  return rows.map((r) => {
    const sleep = r.sleep as Record<string, unknown> | null;
    const readiness = r.readiness as Record<string, unknown> | null;
    const activity = r.activity as Record<string, unknown> | null;
    const hr = r.heartrate as Record<string, unknown> | null;
    const spo2 = r.spo2 as Record<string, unknown> | null;
    const stress = r.stress as Record<string, unknown> | null;
    const resilience = r.resilience as Record<string, unknown> | null;
    const temp = r.temperature as Record<string, unknown> | null;

    const totalSleepSec = num(pick(sleep, "total_sleep_duration"));

    return {
      day: DateTime.fromJSDate(r.day).toISODate()!,
      sleepScore: num(pick(sleep, "score")),
      totalSleepH: totalSleepSec != null ? Math.round((totalSleepSec / 3600) * 10) / 10 : null,
      readiness: num(pick(readiness, "score")),
      activityScore: num(pick(activity, "score")),
      steps: num(pick(activity, "steps")),
      restingHr:
        num(pick(readiness, "resting_heart_rate")) ?? num(pick(hr, "lowest_heart_rate")),
      hrv: num(pick(hr, "average_hrv")),
      tempDeviation: num(pick(temp, "deviation")),
      spo2: num(pick(pick(spo2, "spo2_percentage"), "average")) ?? num(pick(spo2, "average")),
      stressHigh: num(pick(stress, "stress_high")),
      resilience: (pick(resilience, "level") as string) ?? null,
    };
  });
}

export function contextToJson(ctx: DayContext[]): string {
  return JSON.stringify(ctx);
}
