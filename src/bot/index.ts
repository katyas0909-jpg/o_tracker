import { Bot, InlineKeyboard, session, type Context, type SessionFlavor } from "grammy";
import { DateTime } from "luxon";
import { config } from "../config.js";
import { prisma } from "../lib/db.js";
import { randomToken, encrypt } from "../lib/crypto.js";
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

  // ---- /setkey : let each user use their OWN Gemini key ----
  bot.command("setkey", async (ctx) => {
    const user = await getOrCreateUser(ctx.from!.id);
    const lang = langOf(user);
    const key = (ctx.message?.text ?? "").split(/\s+/).slice(1).join("").trim();

    if (!key) {
      await ctx.reply(setkeyText(lang, "howto"), { parse_mode: "Markdown", link_preview_options: { is_disabled: true } });
      return;
    }
    // Basic sanity check on the key shape.
    if (key.length < 20 || /\s/.test(key)) {
      await ctx.reply(setkeyText(lang, "invalid"));
      return;
    }
    await prisma.user.update({ where: { id: user.id }, data: { geminiKeyEnc: encrypt(key) } });
    // Remove the message containing the key from the chat for safety.
    await ctx.deleteMessage().catch(() => {});
    await ctx.reply(setkeyText(lang, "saved"));
  });

  // ---- /removekey : go back to the shared key ----
  bot.command("removekey", async (ctx) => {
    const user = await getOrCreateUser(ctx.from!.id);
    const lang = langOf(user);
    await prisma.user.update({ where: { id: user.id }, data: { geminiKeyEnc: null } });
    await ctx.reply(setkeyText(lang, "removed"));
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

/** Hardcoded 3-language copy for the /setkey flow (kept out of the JSON files). */
function setkeyText(lang: Lang, kind: "howto" | "saved" | "invalid" | "removed"): string {
  const M: Record<Lang, Record<string, string>> = {
    ru: {
      howto:
        "🔑 *Свой ключ Gemini*\n\nПо умолчанию ассистент работает на общем ключе. Хотите использовать свой личный (свой бесплатный лимит) — это по желанию:\n\n1. Откройте aistudio.google.com/app/apikey и войдите Google-аккаунтом\n2. Нажмите *Create API key*, скопируйте ключ (вида `AIza...`)\n3. Пришлите его сюда командой:\n`/setkey ВАШ_КЛЮЧ`\n\nВаш ключ хранится в зашифрованном виде, а сообщение с ним я сразу удаляю. Убрать свой ключ и вернуться на общий — /removekey",
      saved: "Готово! Ваш ключ Gemini сохранён ✅ Теперь ассистент отвечает на вашем ключе. Убрать — /removekey",
      invalid: "Это не похоже на ключ. Пришлите так: /setkey ВАШ_КЛЮЧ (ключ вида AIza..., без пробелов).",
      removed: "Ваш ключ удалён. Ассистент снова использует общий ключ.",
    },
    en: {
      howto:
        "🔑 *Your own Gemini key*\n\nBy default the assistant uses a shared key. Using your own (your own free quota) is optional:\n\n1. Open aistudio.google.com/app/apikey and sign in with Google\n2. Tap *Create API key*, copy the key (looks like `AIza...`)\n3. Send it here as:\n`/setkey YOUR_KEY`\n\nYour key is stored encrypted and I delete the message with it right away. To remove it and go back to the shared key — /removekey",
      saved: "Done! Your Gemini key is saved ✅ The assistant now uses your key. Remove it with /removekey",
      invalid: "That doesn't look like a key. Send it as: /setkey YOUR_KEY (looks like AIza..., no spaces).",
      removed: "Your key was removed. The assistant uses the shared key again.",
    },
    pt: {
      howto:
        "🔑 *A tua própria chave Gemini*\n\nPor defeito o assistente usa uma chave partilhada. Usar a tua (o teu limite gratuito) é opcional:\n\n1. Abre aistudio.google.com/app/apikey e entra com o Google\n2. Toca em *Create API key*, copia a chave (tipo `AIza...`)\n3. Envia-a aqui como:\n`/setkey A_TUA_CHAVE`\n\nA tua chave é guardada encriptada e apago logo a mensagem com ela. Para remover e voltar à chave partilhada — /removekey",
      saved: "Pronto! A tua chave Gemini foi guardada ✅ O assistente usa agora a tua chave. Remover com /removekey",
      invalid: "Isto não parece uma chave. Envia como: /setkey A_TUA_CHAVE (tipo AIza..., sem espaços).",
      removed: "A tua chave foi removida. O assistente volta a usar a chave partilhada.",
    },
  };
  return M[lang][kind] ?? M.ru[kind]!;
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
