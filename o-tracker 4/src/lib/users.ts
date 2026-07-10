import { prisma } from "./db.js";
import { config } from "../config.js";
import type { Lang } from "../i18n/index.js";

export async function getOrCreateUser(telegramId: number | bigint, opts: {
  username?: string;
  firstName?: string;
} = {}) {
  const tid = BigInt(telegramId);
  return prisma.user.upsert({
    where: { telegramId: tid },
    create: {
      telegramId: tid,
      telegramUsername: opts.username ?? null,
      firstName: opts.firstName ?? null,
      language: config.DEFAULT_LANGUAGE,
    },
    update: {
      telegramUsername: opts.username ?? undefined,
      firstName: opts.firstName ?? undefined,
    },
  });
}

export async function getUserByTelegramId(telegramId: number | bigint) {
  return prisma.user.findUnique({ where: { telegramId: BigInt(telegramId) } });
}

export async function setLanguage(userId: number, language: Lang) {
  return prisma.user.update({ where: { id: userId }, data: { language } });
}
