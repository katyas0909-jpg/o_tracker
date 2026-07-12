import { GoogleGenAI } from "@google/genai";
import { DateTime } from "luxon";
import { config } from "../config.js";
import { prisma } from "../lib/db.js";
import { decrypt } from "../lib/crypto.js";
import type { Lang } from "../i18n/index.js";
import { buildMetricContext, contextToJson } from "./context.js";
import {
  dataGroundedSystemPrompt,
  generalHealthSystemPrompt,
  buildUserContext,
} from "./prompts.js";

// Shared owner key (fallback for users who haven't set their own).
const sharedAi = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

/** Return a Gemini client using the user's own key if set, else the shared key. */
async function clientForUser(userId: number): Promise<GoogleGenAI> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { geminiKeyEnc: true },
  });
  if (u?.geminiKeyEnc) {
    try {
      return new GoogleGenAI({ apiKey: decrypt(u.geminiKeyEnc) });
    } catch {
      /* fall back to shared on decrypt error */
    }
  }
  return sharedAi;
}

export type AskMode = "data" | "general";

export type AskResult =
  | { status: "ok"; text: string; mode: AskMode }
  | { status: "quota" }
  | { status: "rate_limited" }
  | { status: "error" };

/** Today's date (UTC) as the quota bucket key. */
function today(): Date {
  return new Date(DateTime.utc().toISODate()!);
}

/** Check + reserve one unit of the user's daily Gemini quota. Returns false if exhausted. */
export async function reserveQuota(userId: number): Promise<boolean> {
  const day = today();
  const row = await prisma.geminiUsage.upsert({
    where: { userId_day: { userId, day } },
    create: { userId, day, count: 1 },
    update: { count: { increment: 1 } },
  });
  if (row.count > config.GEMINI_DAILY_QUOTA_PER_USER) {
    // Roll back the reservation so the counter reflects real usage.
    await prisma.geminiUsage.update({
      where: { userId_day: { userId, day } },
      data: { count: { decrement: 1 } },
    });
    return false;
  }
  return true;
}

interface AskOptions {
  userId: number;
  lang: Lang;
  question: string;
  mode: AskMode;
}

/**
 * Ask Gemini. In "data" mode the user's recent metrics are injected as context
 * and the model is instructed to answer only from them. Quota is enforced by the
 * caller via reserveQuota() before calling generate-heavy paths, but we also
 * gracefully surface 429s from the shared free tier.
 */
export async function ask(opts: AskOptions): Promise<AskResult> {
  const { userId, lang, question, mode } = opts;

  let systemInstruction: string;
  let contents: string;

  if (mode === "data") {
    const ctx = await buildMetricContext(userId, config.METRIC_CONTEXT_DAYS);
    systemInstruction = dataGroundedSystemPrompt(lang);
    contents = `${buildUserContext(contextToJson(ctx), config.METRIC_CONTEXT_DAYS)}\n\nUser question: ${question}`;
  } else {
    systemInstruction = generalHealthSystemPrompt(lang);
    contents = question;
  }

  try {
    const ai = await clientForUser(userId);
    const res = await ai.models.generateContent({
      model: config.GEMINI_MODEL,
      contents,
      config: {
        systemInstruction,
        temperature: 0.6,
        // High cap because "thinking" models spend part of this budget on internal
        // reasoning; a low cap truncates the visible answer mid-sentence.
        maxOutputTokens: 4096,
      },
    });
    const text = (res.text ?? "").trim();
    if (!text) return { status: "error" };
    return { status: "ok", text, mode };
  } catch (err: unknown) {
    const msg = String((err as { message?: string })?.message ?? err);
    if (msg.includes("429") || /rate|quota|RESOURCE_EXHAUSTED/i.test(msg)) {
      return { status: "rate_limited" };
    }
    console.error("[gemini] generateContent failed:", msg);
    return { status: "error" };
  }
}

/** Generate the 1-2 line observation used in the daily summary (data mode). */
export async function summaryObservation(userId: number, lang: Lang): Promise<string | null> {
  const ctx = await buildMetricContext(userId, config.METRIC_CONTEXT_DAYS);
  if (ctx.length === 0) return null;
  try {
    const ai = await clientForUser(userId);
    const res = await ai.models.generateContent({
      model: config.GEMINI_MODEL,
      contents:
        `${buildUserContext(contextToJson(ctx), config.METRIC_CONTEXT_DAYS)}\n\n` +
        `Write ONE short, friendly observation (max 2 sentences) about a notable trend in this data, ` +
        `plus one concrete suggestion for today. Reply in the user's language.`,
      config: {
        systemInstruction: dataGroundedSystemPrompt(lang),
        temperature: 0.6,
        maxOutputTokens: 1024,
      },
    });
    const text = (res.text ?? "").trim();
    return text || null;
  } catch (err) {
    console.error("[gemini] summary observation failed:", err);
    return null; // summary still goes out without the observation
  }
}
