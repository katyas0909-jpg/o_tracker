import { getValidAccessToken } from "./tokens.js";

/**
 * Thin client over the Oura API v2. Endpoint availability depends on ring
 * generation and Oura Membership, so callers must tolerate empty results.
 * Docs: https://cloud.ouraring.com/v2/docs
 */

const BASE = "https://api.ouraring.com/v2/usercollection";

export class OuraAuthError extends Error {}

interface DateRange {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
}

export interface OuraDailyDoc {
  id?: string;
  day?: string;
  [k: string]: unknown;
}

async function get<T = unknown>(
  accessToken: string,
  path: string,
  query: Record<string, string>,
): Promise<T> {
  const url = `${BASE}/${path}?${new URLSearchParams(query).toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401 || res.status === 403) {
    throw new OuraAuthError(`Oura auth error ${res.status} on ${path}`);
  }
  if (res.status === 429) {
    throw new Error("Oura rate limit (429)");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Oura API ${res.status} on ${path}: ${text}`);
  }
  return (await res.json()) as T;
}

interface Paged<T> {
  data: T[];
  next_token?: string | null;
}

export class OuraClient {
  constructor(private readonly accessToken: string) {}

  /** Build a client that auto-resolves (and refreshes) the user's token. */
  static async forUser(userId: number): Promise<OuraClient> {
    const token = await getValidAccessToken(userId);
    if (!token) throw new OuraAuthError(`No valid Oura token for user ${userId}`);
    return new OuraClient(token);
  }

  private daily(path: string, range: DateRange) {
    return get<Paged<OuraDailyDoc>>(this.accessToken, path, {
      start_date: range.start,
      end_date: range.end,
    }).then((r) => r.data ?? []);
  }

  dailySleep(r: DateRange) {
    return this.daily("daily_sleep", r);
  }
  dailyReadiness(r: DateRange) {
    return this.daily("daily_readiness", r);
  }
  dailyActivity(r: DateRange) {
    return this.daily("daily_activity", r);
  }
  dailySpo2(r: DateRange) {
    return this.daily("daily_spo2", r);
  }
  dailyStress(r: DateRange) {
    return this.daily("daily_stress", r);
  }
  dailyResilience(r: DateRange) {
    return this.daily("daily_resilience", r);
  }
  dailyCardiovascularAge(r: DateRange) {
    return this.daily("daily_cardiovascular_age", r);
  }
  /** Detailed sleep periods (has HRV, respiratory rate, phases). */
  sleepPeriods(r: DateRange) {
    return this.daily("sleep", r);
  }
  vo2Max(r: DateRange) {
    // Endpoint is `vO2_max` in the Oura API.
    return this.daily("vO2_max", r);
  }

  /** Profile — also used as a lightweight connectivity check. */
  personalInfo() {
    return get<OuraDailyDoc>(this.accessToken, "personal_info", {});
  }
}
