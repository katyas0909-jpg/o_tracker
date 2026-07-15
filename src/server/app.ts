import { fileURLToPath } from "node:url";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyFormbody from "@fastify/formbody";
import { webhookCallback, type Bot } from "grammy";
import { config, TELEGRAM_WEBHOOK_PATH } from "../config.js";
import { prisma } from "../lib/db.js";
import { DateTime } from "luxon";
import { buildAuthorizeUrl, exchangeCode } from "../oura/oauth.js";
import { saveTokens } from "../oura/tokens.js";
import { syncUser } from "../oura/sync.js";
import { buildDashboard } from "./dashboardData.js";
import { verifyTelegramAuth, type TelegramAuthData } from "./telegramAuth.js";
import { t, normalizeLang } from "../i18n/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = path.join(__dirname, "..", "dashboard");
const LEGAL_DIR = path.join(__dirname, "..", "legal");

export async function buildServer(bot: Bot): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.NODE_ENV === "development" ? "info" : "warn" } });
  await app.register(fastifyFormbody);

  // ---- Security headers on every response ----
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "SAMEORIGIN");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    reply.header("X-XSS-Protection", "0");
    return payload;
  });

  // ---- Telegram webhook ----
  // Path secrecy + secret_token header both gate this endpoint.
  app.post(
    TELEGRAM_WEBHOOK_PATH,
    webhookCallback(bot, "fastify", { secretToken: config.TELEGRAM_WEBHOOK_SECRET }),
  );

  // ---- Oura: start connect (validates one-time state, redirects to consent) ----
  app.get<{ Querystring: { state?: string } }>("/connect/oura", async (req, reply) => {
    const state = req.query.state;
    if (!state) return reply.code(400).send("Missing state");
    const row = await prisma.oAuthState.findUnique({ where: { state } });
    if (!row || row.expiresAt < new Date()) {
      return reply.code(400).type("text/html").send(page("Link expired", "This connection link has expired. Please run /connect in the bot again."));
    }
    return reply.redirect(buildAuthorizeUrl(state));
  });

  // ---- Oura: OAuth callback ----
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/oauth/oura/callback",
    async (req, reply) => {
      const { code, state, error } = req.query;
      if (error) return reply.code(400).type("text/html").send(page("Authorization declined", "You declined the Oura authorization. You can try again with /connect."));
      if (!code || !state) return reply.code(400).send("Missing code/state");

      const stateRow = await prisma.oAuthState.findUnique({ where: { state }, include: { user: true } });
      if (!stateRow || stateRow.expiresAt < new Date()) {
        return reply.code(400).type("text/html").send(page("Link expired", "This link has expired. Please run /connect again."));
      }

      try {
        const tok = await exchangeCode(code);
        await saveTokens(stateRow.userId, tok);
        await prisma.oAuthState.delete({ where: { state } }).catch(() => {});
        // Initial data pull (best-effort, don't block the response too long).
        syncUser(stateRow.userId, 30).catch((e) => req.log.error(e));

        const lang = normalizeLang(stateRow.user.language);
        bot.api
          .sendMessage(stateRow.user.telegramId.toString(), t(lang, "connect.success"), { parse_mode: "Markdown" })
          .catch((e) => req.log.error(e));

        return reply.type("text/html").send(page("Connected ✅", "Your Oura account is now connected. You can close this window and return to Telegram."));
      } catch (err) {
        req.log.error(err);
        return reply.code(500).type("text/html").send(page("Something went wrong", "We couldn't complete the connection. Please try /connect again."));
      }
    },
  );

  // ---- Dashboard data API (Telegram Login Widget auth) ----
  app.get<{ Querystring: Record<string, string> }>("/api/dashboard", async (req, reply) => {
    const q = req.query as unknown as TelegramAuthData;
    if (!q.id || !q.hash || !verifyTelegramAuth(q)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const user = await prisma.user.findUnique({ where: { telegramId: BigInt(q.id) } });
    if (!user) return reply.code(404).send({ error: "no_user" });
    const data = await buildDashboard(user.id, 30);
    return reply.send({ language: user.language, ...data });
  });

  // ---- Legal pages ----
  app.get("/privacy", (_req, reply) => reply.type("text/html").sendFile("privacy.html", LEGAL_DIR));
  app.get("/terms", (_req, reply) => reply.type("text/html").sendFile("terms.html", LEGAL_DIR));

  // ---- Health check ----
  app.get("/healthz", async () => ({ ok: true, ts: DateTime.utc().toISO() }));

  // ---- Static dashboard (served at root) ----
  await app.register(fastifyStatic, { root: DASHBOARD_DIR, prefix: "/" });
  // second static root for legal sendFile
  await app.register(fastifyStatic, { root: LEGAL_DIR, prefix: "/legal/", decorateReply: false });

  return app;
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · O Tracker</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070d1c;color:#eef3fc;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.card{max-width:420px;padding:32px;text-align:center}.mark{width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,#57a5ff,#24467e);display:grid;place-items:center;margin:0 auto 18px;font-weight:800;color:#fff;font-size:22px}
h1{font-size:20px;margin:0 0 8px}p{color:#aebbd6;line-height:1.5}</style></head>
<body><div class="card"><div class="mark">O</div><h1>${title}</h1><p>${body}</p></div></body></html>`;
}
