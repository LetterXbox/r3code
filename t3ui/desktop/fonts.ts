// queryInstalledFontFamilies / isMonospaceFamily (apps/web/src/appearanceFonts.ts): the web asks the browser's
// queryLocalFonts and measures glyph widths on a canvas; here macOS answers through osascript (JXA over AppKit):
// NSFontManager.availableFontFamilies, and NSFont.isFixedPitch for each family's regular face.
import { signal } from "nsh";
import { desktop, isMac } from "./runtime";
import { OSASCRIPT } from "./dialogs";

export type FontEnumerationState =
  | { status: "unknown" }
  | { status: "granted"; families: readonly string[]; monospace: ReadonlySet<string> }
  | { status: "unavailable" };

const SCRIPT = 'ObjC.import("AppKit");var m=$.NSFontManager.sharedFontManager;var f=ObjC.deepUnwrap(m.availableFontFamilies);'
  + 'JSON.stringify(f.map(function(n){var x=$.NSFont.fontWithNameSize(n,12);return [n,!!(x&&!x.isNil()&&x.isFixedPitch)];}))';

export function parseFontListing(stdout: string): { families: string[]; monospace: Set<string> } | null {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (!Array.isArray(parsed)) return null;
    const entries = parsed.filter((entry): entry is [string, boolean] => Array.isArray(entry) && typeof entry[0] === "string" && !entry[0].startsWith("."));
    const families = [...new Set(entries.map(([name]) => name))].sort((a, b) => a.localeCompare(b));
    return { families, monospace: new Set(entries.filter(([, fixed]) => fixed === true).map(([name]) => name)) };
  } catch {
    return null;
  }
}

const state = signal<FontEnumerationState>({ status: "unknown" });
let loading: Promise<void> | null = null;

export const fontEnumeration = () => state();

/** discoverInstalledFonts: asks once; macOS needs no permission prompt. */
export function discoverInstalledFonts(): Promise<void> {
  if (state().status !== "unknown") return Promise.resolve();
  if (loading) return loading;
  if (!isMac()) { state.set({ status: "unavailable" }); return Promise.resolve(); }
  loading = desktop().run(OSASCRIPT, ["-l", "JavaScript", "-e", SCRIPT], { timeoutMs: 20_000 }).then((output) => {
    const listing = output.code === 0 ? parseFontListing(output.stdout) : null;
    if (!listing) console.warn(`[fonts] listing failed: code=${output.code} stderr=${output.stderr.slice(0, 300)} stdout=${output.stdout.slice(0, 200)}`);
    // A failed listing (a slow machine timing out) is asked again by the next picker that mounts; the field shows meanwhile.
    state.set(listing && listing.families.length > 0 ? { status: "granted", families: listing.families, monospace: listing.monospace } : { status: "unknown" });
  }).catch((cause) => { console.warn(`[fonts] listing threw: ${cause instanceof Error ? cause.message : String(cause)}`); state.set({ status: "unknown" }); }).finally(() => { loading = null; });
  return loading;
}

/** Tests. */
export function setFontEnumerationForTest(next: FontEnumerationState) { state.set(next); }

export function isMonospaceFamily(family: string): boolean {
  const current = state();
  return current.status === "granted" && current.monospace.has(family);
}

const GENERIC_FAMILIES = /^(system-ui|sans-serif|serif|monospace|ui-monospace|ui-sans-serif|ui-serif|cursive|fantasy)$/i;
const MONOSPACE_GENERICS = /^(monospace|ui-monospace)$/i;
const familyNames = (input: string) => input.split(",").map((name) => name.trim().replace(/^["']|["']$/g, "").trim()).filter((name) => name.length > 0);

/**
 * isFontFamilyAvailable: a typed family list resolves to something installed (a generic counts). The web probes canvas
 * widths; here the answer is the installed listing, so with no listing yet the family is taken on trust (true).
 */
export function isFontFamilyAvailable(family: string): boolean {
  const names = familyNames(family);
  if (names.length === 0) return false;
  const current = state();
  if (current.status !== "granted") return true;
  const installed = new Set(current.families.map((name) => name.toLowerCase()));
  return names.some((name) => GENERIC_FAMILIES.test(name) || installed.has(name.toLowerCase()));
}

/** isMonospaceFamily for a typed list: the first family that resolves (installed or generic) decides; unknown is true, as the web's probe failure is. */
export function isMonospaceFamilyList(family: string): boolean {
  const current = state();
  if (current.status !== "granted") return true;
  const byLower = new Map(current.families.map((name) => [name.toLowerCase(), name] as const));
  for (const name of familyNames(family)) {
    if (GENERIC_FAMILIES.test(name)) return MONOSPACE_GENERICS.test(name);
    const installed = byLower.get(name.toLowerCase());
    if (installed) return current.monospace.has(installed);
  }
  return true;
}
