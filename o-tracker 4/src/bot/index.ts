import { Bot, InlineKeyboard, session, type Context, type SessionFlavor } from "grammy";
import { DateTime } from "luxon";
import { config } from "../config.js";
import { prisma } from "../lib/db.js";
import { randomToken } from "../lib/crypto.js";
import { t, normalizeLang, LANG_LABELS, type Lang } from "../i18n/index.js";
import { getOrCreateUser, getUserByTelegramId, setLanguage } from "../lib/users.js";
import { ask, reserveQuota } from "../gemini/assistant.js";
import { syncUser } from "../oura/sync.js";
import { deleteTokens } from "../oura/tokens.js";
import { composeSummary } from "./summary.js";

interface SessionData {
  awaiting?: "summaryTime" | "timezone";
}
type Ctx = Context & SessionFlavor<SessionData>;

const OAUTH_STATE_TTL_MIN = 10;

/** Create a one-time OAuth state bound to the user and return the connect link. */
async function createConnectLink(userId: number): Promise<string> {
  const state = randomToken(24);
  await prisma.oAuthState.create({
    data: {
      state,
      userId,
      expiresAt: DateTime.utc().plus({ minutes: OAUTH_STATE_TTL_MIN }).toJSDate(),
    },
  });
  return `${config.PUBLIC_URL}/connect/oura?state=${state}`;
}

export function createBot(): Bot<Ctx> {
  const bot = new Bot<Ctx>(config.TELEGRAM_BOT_TOKEN);
  bot.use(session({ initial: (): SessionData => ({}) }));

  const langOf = (u: { language: Lang } | null): Lang => normalizeLang(u?.language);

  // ---- /start : onboarding with language choice ----
  bot.command("start", async (ctx) => {
    const user = await getOrCreateUser(ctx.from!.id, {
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
    });
    const lang = langOf(user);
    const kb = new InlineKeyboard()
      .text("Русский 🇷🇺", "lang:ru")
      .text("English 🇬🇧", "lang:en")
      .text("Português 🇵🇹", "lang:pt");
    await ctx.reply(t(lang, "start.welcome"), { parse_mode: "Markdown" });
    await ctx.reply(t(lang, "start.chooseLanguage"), { reply_markup: kb });
  });

  // ---- language selection callback ----
  bot.callbackQuery(/^lang:(ru|en|pt)$/, async (ctx) => {
    const lang = ctx.match![1] as Lang;
    const user = await getOrCreateUser(ctx.from.id);
    await setLanguage(user.id, lang);
    await ctx.answerCallbackQuery();
    await ctx.reply(t(lang, "start.languageSet"));
    await sendConnectPrompt(ctx, user.id, lang);
  });

  // ---- /language ----
  bot.command("language", async (ctx) => {
    const user = await getOrCreateUser(ctx.from!.id);
    const kb = new InlineKeyboard()
      .text("Русский 🇷🇺", "lang:ru")
      .text("English 🇬🇧", "lang:en")
      .text("Português 🇵🇹", "lang:pt");
    await ctx.reply(t(langOf(user), "start.chooseLanguage"), { reply_markup: kb });
  });

  // ---- /connect ----
  bot.command("connect", async (ctx) => {
    const user = await getOrCreateUser(ctx.from!.id);
    await sendConnectPrompt(ctx, user.id, langOf(user));
  });

  async function sendConnectPrompt(ctx: Ctx, userId: number, lang: Lang) {
    const link = await createConnectLink(userId);
    const kb = new InlineKeyboard().url(t(lang, "connect.button"), link);
    await ctx.reply(t(lang, "connect.prompt"), { reply_markup: kb });
  }

  // ---- /today ----
  bot.command("today", async (ctx) => {
    const user = await getUserByTelegramId(ctx.from!.id);
    if (!user) return;
    const lang = langOf(user);
    if (!user.ouraConnected) {
      return ctx.reply(t(lang, "assistant.notConnected"));
    }
    await syncUser(user.id, 2).catch(() => {});
    const { text, keyboard } = await composeSummary(user.id, lang, { withObservation: false });
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
  });

  // ---- /week ----
  bot.command("week", async (ctx) => {
    const user = await getUserByTelegramId(ctx.from!.id);
    if (!user) return;
    const lang = langOf(user);
    if (!user.ouraConnected) return ctx.reply(t(lang, "assistant.notConnected"));
    if (!(await reserveQuota(user.id))) return ctx.reply(t(lang, "assistant.quotaReached"));
    await ctx.replyWithChatAction("typing");
    const res = await ask({
      userId: user.id,
      lang,
      mode: user.generalHealthMode ? "general" : "data",
      question:
        lang === "ru"
          ? "Сделай короткий обзор моей недели: сон, готовность, активность — и один совет."
          : lang === "pt"
            ? "Faz um resumo curto da minha semana: sono, prontidão, atividade — e um conselho."
            : "Give a short overview of my week: sleep, readiness, activity — and one tip.",
    });
    await replyAsk(ctx, lang, res);
  });

  // ---- /settings ----
  bot.command("settings", async (ctx) => {
    const user = await getUserByTelegramId(ctx.from!.id);
    if (!user) return;
    const lang = langOf(user);
    await ctx.reply(settingsText(lang, user), { reply_markup: settingsKeyboard(lang, user) });
  });

  bot.callbackQuery("set:summaryTime", async (ctx) => {
    const user = await getUserByTelegramId(ctx.from.id);
    if (!user) return;
    ctx.session.awaiting = "summaryTime";
    await ctx.answerCallbackQuery();
    await ctx.reply(t(langOf(user), "settings.askSummaryTime"));
  });

  bot.callbackQuery("set:timezone", async (ctx) => {
    const user = await getUserByTelegramId(ctx.from.id);
    if (!user) return;
    ctx.session.awaiting = "timezone";
    await ctx.answerCallbackQuery();
    await ctx.reply(t(langOf(user), "settings.askTimezone"));
  });

  bot.callbackQuery("set:generalToggle", async (ctx) => {
    const user = await getUserByTelegramId(ctx.from.id);
    if (!user) return;
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { generalHealthMode: !user.generalHealthMode },
    });
    const lang = langOf(updated);
    await ctx.answerCallbackQuery();
    await ctx.reply(
      t(lang, "settings.generalToggled", {
        state: updated.generalHealthMode ? t(lang, "settings.on") : t(lang, "settings.off"),
      }),
    );
    await ctx.editMessageReplyMarkup({ reply_markup: settingsKeyboard(lang, updated) }).catch(() => {});
  });

  bot.callbackQuery("set:disconnect", async (ctx) => {
    const user = await getUserByTelegramId(ctx.from.id);
    if (!user) return;
    const lang = langOf(user);
    await deleteTokens(user.id);
    await prisma.dailyMetric.deleteMany({ where: { userId: user.id } });
    await ctx.answerCallbackQuery();
    await ctx.reply(t(lang, "settings.disconnected"));
  });

  // ---- /help ----
  bot.command("help", async (ctx) => {
    const user = await getOrCreateUser(ctx.from!.id);
    await ctx.reply(t(langOf(user), "help.text"), { parse_mode: "Markdown" });
  });

  // ---- free text ----
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return; // unknown command; ignore
    const user = await getUserByTelegramId(ctx.from.id);
    if (!user) {
      await getOrCreateUser(ctx.from.id, { username: ctx.from.username, firstName: ctx.from.first_name });
      return ctx.reply(t(config.DEFAULT_LANGUAGE, "assistant.notConnected"));
    }
    const lang = langOf(user);

    // settings multi-step inputs
    if (ctx.session.awaiting === "summaryTime") {
      ctx.session.awaiting = undefined;
      const m = text.match(/^(\d{1,2}):(\d{2})$/);
      const hour = m ? Number(m[1]) : NaN;
      if (!m || hour < 0 || hour > 23) return ctx.reply(t(lang, "settings.askSummaryTime"));
      await prisma.user.update({ where: { id: user.id }, data: { summaryHour: hour } });
      return ctx.reply(t(lang, "settings.summaryTimeSet", { time: `${String(hour).padStart(2, "0")}:00` }));
    }
    if (ctx.session.awaiting === "timezone") {
      ctx.session.awaiting = undefined;
      if (!DateTime.now().setZone(text).isValid) return ctx.reply(t(lang, "settings.askTimezone"));
      await prisma.user.update({ where: { id: user.id }, data: { timezone: text } });
      return ctx.reply(t(lang, "settings.timezoneSet", { tz: text }));
    }

    if (!user.ouraConnected) return ctx.reply(t(lang, "assistant.notConnected"));

    if (!(await reserveQuota(user.id))) return ctx.reply(t(lang, "assistant.quotaReached"));
    await ctx.replyWithChatAction("typing");
    const res = await ask({
      userId: user.id,
      lang,
      mode: user.generalHealthMode ? "general" : "data",
      question: text,
    });
    await replyAsk(ctx, lang, res);
  });

  bot.catch((err) => {
    console.error("[bot] error:", err.error);
  });

  return bot;
}

async function replyAsk(
  ctx: Ctx,
  lang: Lang,
  res: Awaited<ReturnType<typeof ask>>,
): Promise<void> {
  if (res.status === "quota") return void ctx.reply(t(lang, "assistant.quotaReached"));
  if (res.status === "rate_limited") return void ctx.reply(t(lang, "assistant.rateLimited"));
  if (res.status === "error") return void ctx.reply(t(lang, "assistant.error"));
  const prefix = res.mode === "general" ? t(lang, "assistant.generalTag") + "\n\n" : "";
  await ctx.reply(prefix + res.text);
}

function settingsText(lang: Lang, user: { language: Lang; timezone: string; summaryHour: number; generalHealthMode: boolean }): string {
  const on = user.generalHealthMode ? t(lang, "settings.on") : t(lang, "settings.off");
  return [
    t(lang, "settings.title"),
    t(lang, "settings.language", { lang: LANG_LABELS[normalizeLang(user.language)] }),
    t(lang, "settings.timezone", { tz: user.timezone }),
    t(lang, "settings.summaryTime", { time: `${String(user.summaryHour).padStart(2, "0")}:00` }),
    t(lang, "settings.generalMode", { state: on }),
  ].join("\n");
}

function settingsKeyboard(lang: Lang, user: { generalHealthMode: boolean }): InlineKeyboard {
  return new InlineKeyboard()
    .text("🕗 " + t(lang, "settings.summaryTime", { time: "" }).trim(), "set:summaryTime")
    .row()
    .text("🌍 " + t(lang, "settings.timezone", { tz: "" }).trim(), "set:timezone")
    .row()
    .text(
      "💬 " + t(lang, "settings.generalMode", { state: user.generalHealthMode ? t(lang, "settings.on") : t(lang, "settings.off") }),
      "set:generalToggle",
    )
    .row()
    .text(t(lang, "settings.disconnect"), "set:disconnect");
}
