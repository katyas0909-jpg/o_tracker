import ru from "./ru.json" with { type: "json" };
import en from "./en.json" with { type: "json" };
import pt from "./pt.json" with { type: "json" };
import { config } from "../config.js";

export type Lang = "ru" | "en" | "pt";
export const LANGS: Lang[] = ["ru", "en", "pt"];
export const LANG_LABELS: Record<Lang, string> = { ru: "Русский", en: "English", pt: "Português" };

const DICTS: Record<Lang, unknown> = { ru, en, pt };

/** Resolve a dotted key path against a dictionary object. */
function lookup(dict: unknown, path: string): string | undefined {
  const parts = path.split(".");
  let cur: unknown = dict;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return typeof cur === "string" ? cur : undefined;
}

/**
 * Translate `key` (dotted path, e.g. "summary.title") into `lang`,
 * interpolating `{placeholders}` from `params`. Falls back to the
 * default language, then to the raw key.
 */
export function t(
  lang: Lang,
  key: string,
  params: Record<string, string | number> = {},
): string {
  const raw =
    lookup(DICTS[lang], key) ??
    lookup(DICTS[config.DEFAULT_LANGUAGE], key) ??
    key;
  return raw.replace(/\{(\w+)\}/g, (_, k) =>
    k in params ? String(params[k]) : `{${k}}`,
  );
}

export function normalizeLang(input?: string | null): Lang {
  if (input && (LANGS as string[]).includes(input)) return input as Lang;
  return config.DEFAULT_LANGUAGE;
}
