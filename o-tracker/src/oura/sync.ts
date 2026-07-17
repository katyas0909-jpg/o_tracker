import { DateTime } from "luxon";
import { prisma } from "../lib/db.js";
import { OuraClient, OuraAuthError, type OuraDailyDoc } from "./client.js";
import { deleteTokens } from "./tokens.js";

/**
 * Sync a user's recent Oura data into the daily_metrics cache. The dashboard and
 * Gemini read only from this cache, never live from Oura.
 */

function indexByDay(docs: OuraDailyDoc[]): Map<string, OuraDailyDoc> {
  const m = new Map<string, OuraDailyDoc>();
  for (const d of docs) {
    const day = (d.day as string) ?? (typeof d.timestamp === "string" ? d.timestamp.slice(0, 10) : undefined);
    if (day) m.set(day, d);
  }
  return m;
}

export interface SyncResult {
  days: number;
  ok: boolean;
  disconnected?: boolean;
}

export async function syncUser(userId: number, days = 30): Promise<SyncResult> {
  let client: OuraClient;
  try {
    client = await OuraClient.forUser(userId);
  } catch (err) {
    if (err instanceof OuraAuthError) return { days: 0, ok: false, disconnected: true };
    throw err;
  }

  const endDt = DateTime.utc();
  const startDt = endDt.minus({ days });
  const range = { start: startDt.toISODate()!, end: endDt.toISODate()! };

  try {
    const [sleep, readiness, activity, spo2, stress, resilience, cardio, sleepPeriods, vo2] =
      await Promise.all([
        client.dailySleep(range).catch(() => []),
        client.dailyReadiness(range).catch(() => []),
        client.dailyActivity(range).catch(() => []),
        client.dailySpo2(range).catch(() => []),
        client.dailyStress(range).catch(() => []),
        client.dailyResilience(range).catch(() => []),
        client.dailyCardiovascularAge(range).catch(() => []),
        client.sleepPeriods(range).catch(() => []),
        client.vo2Max(range).catch(() => []),
      ]);

    const byDay = {
      sleep: indexByDay(sleep),
      readiness: indexByDay(readiness),
      activity: indexByDay(activity),
      spo2: indexByDay(spo2),
      stress: indexByDay(stress),
      resilience: indexByDay(resilience),
      cardio: indexByDay(cardio),
      periods: indexByDay(sleepPeriods),
      vo2: indexByDay(vo2),
    };

    // Union of all days that appeared in any collection.
    const allDays = new Set<string>();
    Object.values(byDay).forEach((m) => m.forEach((_v, k) => allDays.add(k)));

    for (const day of allDays) {
      const period = byDay.periods.get(day);
      const sleepScoreDoc = byDay.sleep.get(day);
      // Merge the detailed sleep period (durations, phases, HRV, breathing) with
      // the daily_sleep score doc so the dashboard has both in one `sleep` object.
      const mergedSleep =
        period || sleepScoreDoc
          ? {
              ...(period ?? {}),
              score: sleepScoreDoc?.score ?? (period?.score ?? null),
              restfulness:
                (sleepScoreDoc?.contributors as Record<string, unknown> | undefined)?.restfulness ?? null,
            }
          : undefined;

      const heartrate =
        period && (period.average_heart_rate || period.lowest_heart_rate || period.average_hrv)
          ? {
              average_heart_rate: period.average_heart_rate ?? null,
              lowest_heart_rate: period.lowest_heart_rate ?? null,
              average_hrv: period.average_hrv ?? null,
              average_breath: period.average_breath ?? null,
            }
          : undefined;

      const cardioSnap =
        byDay.cardio.get(day) || byDay.vo2.get(day)
          ? {
              cardiovascular_age: byDay.cardio.get(day)?.vascular_age ?? null,
              vo2_max: byDay.vo2.get(day)?.vo2_max ?? null,
            }
          : undefined;

      const payload = {
        sleep: mergedSleep ?? undefined,
        readiness: byDay.readiness.get(day) ?? undefined,
        activity: byDay.activity.get(day) ?? undefined,
        heartrate,
        spo2: byDay.spo2.get(day) ?? undefined,
        stress: byDay.stress.get(day) ?? undefined,
        resilience: byDay.resilience.get(day) ?? undefined,
        temperature:
          byDay.readiness.get(day)?.temperature_deviation !== undefined
            ? {
                deviation: byDay.readiness.get(day)?.temperature_deviation ?? null,
                trend: byDay.readiness.get(day)?.temperature_trend_deviation ?? null,
              }
            : undefined,
        cardio: cardioSnap,
      };

      // Prisma Json fields: use `undefined` to skip, not null-overwrite.
      await prisma.dailyMetric.upsert({
        where: { userId_day: { userId, day: new Date(day) } },
        create: {
          userId,
          day: new Date(day),
          sleep: payload.sleep ?? undefined,
          readiness: payload.readiness ?? undefined,
          activity: payload.activity ?? undefined,
          heartrate: payload.heartrate ?? undefined,
          spo2: payload.spo2 ?? undefined,
          stress: payload.stress ?? undefined,
          resilience: payload.resilience ?? undefined,
          temperature: payload.temperature ?? undefined,
          cardio: payload.cardio ?? undefined,
        },
        update: {
          sleep: payload.sleep ?? undefined,
          readiness: payload.readiness ?? undefined,
          activity: payload.activity ?? undefined,
          heartrate: payload.heartrate ?? undefined,
          spo2: payload.spo2 ?? undefined,
          stress: payload.stress ?? undefined,
          resilience: payload.resilience ?? undefined,
          temperature: payload.temperature ?? undefined,
          cardio: payload.cardio ?? undefined,
        },
      });
    }

    return { days: allDays.size, ok: true };
  } catch (err) {
    if (err instanceof OuraAuthError) {
      // Token no longer valid and couldn't be refreshed — mark disconnected.
      await deleteTokens(userId).catch(() => {});
      return { days: 0, ok: false, disconnected: true };
    }
    throw err;
  }
}
