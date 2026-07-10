import { PrismaClient } from "@prisma/client";

/** Single shared Prisma client for the process. */
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}
