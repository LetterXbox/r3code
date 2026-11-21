import { signal } from "nsh";
import { DEFAULT_LOCALE } from "./locales";

export type MessageVars = Record<string, string | number | boolean | null | undefined>;

const activeLocaleSignal = signal<string>(DEFAULT_LOCALE);
const formattingLocaleSignal = signal<string>(DEFAULT_LOCALE);
const catalogRevisionSignal = signal(0);

const catalogs = new Map<string, Readonly<Record<string, string>>>();

export function registerLocaleCatalog(locale: string, entries: Readonly<Record<string, string>>): void {
  catalogs.set(locale, entries);
  if (activeLocaleSignal() === locale) {
    catalogRevisionSignal.update((n) => n + 1);
  }
}

export function setActiveLocale(locale: string, formatLocale: string = locale): void {
  activeLocaleSignal.set(locale);
  formattingLocaleSignal.set(formatLocale);
  catalogRevisionSignal.update((n) => n + 1);
}

export function getActiveLocale(): string {
  return activeLocaleSignal();
}

export function getFormattingLocale(): string {
  return formattingLocaleSignal();
}

export function localeSignal(): string {
  catalogRevisionSignal();
  return activeLocaleSignal();
}

function formatPlural(body: string, count: number, locale: string, vars: MessageVars): string {
  const category =
    typeof Intl !== "undefined" && typeof Intl.PluralRules === "function"
      ? new Intl.PluralRules(locale).select(count)
      : count === 1
        ? "one"
        : "other";
  const forms = new Map<string, string>();
  let index = 0;
  while (index < body.length) {
    while (index < body.length && /\s/.test(body[index]!)) index += 1;
    const keyStart = index;
    while (index < body.length && !/[\s{]/.test(body[index]!)) index += 1;
    const key = body.slice(keyStart, index);
    while (index < body.length && /\s/.test(body[index]!)) index += 1;
    if (body[index] !== "{") break;
    index += 1;
    let depth = 1;
    const valStart = index;
    while (index < body.length && depth > 0) {
      if (body[index] === "{") depth += 1;
      else if (body[index] === "}") depth -= 1;
      index += 1;
    }
    const rawValue = body.slice(valStart, index - 1);
    forms.set(key, rawValue);
  }
  const exact = forms.get(`=${count}`);
  const picked = exact ?? forms.get(category) ?? forms.get("other") ?? "";
  return interpolate(picked.replaceAll("#", String(count)), locale, vars);
}

function interpolate(template: string, locale: string, vars?: MessageVars): string {
  if (!template.includes("{")) return template;
  let out = "";
  let i = 0;
  while (i < template.length) {
    if (template[i] !== "{") {
      out += template[i];
      i += 1;
      continue;
    }
    let depth = 1;
    let j = i + 1;
    while (j < template.length && depth > 0) {
      if (template[j] === "{") depth += 1;
      else if (template[j] === "}") depth -= 1;
      j += 1;
    }
    if (depth !== 0) {
      out += template.slice(i);
      break;
    }
    const expr = template.slice(i + 1, j - 1);
    const comma = expr.indexOf(",");
    if (comma < 0) {
      const key = expr.trim();
      const val = vars?.[key];
      out += val === undefined || val === null ? `{${expr}}` : String(val);
    } else {
      const key = expr.slice(0, comma).trim();
      const rest = expr.slice(comma + 1).trimStart();
      if (rest.startsWith("plural,")) {
        const count = Number(vars?.[key] ?? 0);
        out += formatPlural(rest.slice("plural,".length), Number.isFinite(count) ? count : 0, locale, vars ?? {});
      } else {
        const val = vars?.[key];
        out += val === undefined || val === null ? `{${expr}}` : String(val);
      }
    }
    i = j;
  }
  return out;
}

/**
 * Resolves a UI string in the active locale. Reactive inside nsh render/effect closures.
 */
export function m(source: string, vars?: MessageVars): string {
  catalogRevisionSignal();
  const locale = activeLocaleSignal();
  if (locale !== DEFAULT_LOCALE) {
    const translated = catalogs.get(locale)?.[source];
    if (typeof translated === "string") {
      return interpolate(translated, locale, vars);
    }
  }
  return interpolate(source, DEFAULT_LOCALE, vars);
}

/** Marker/lookup alias matching the web's msg()/gt() conventions. */
export const msg = m;
export const gt = m;
