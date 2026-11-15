// desktop/src/preview/BrowserImport/Sources.ts + BrowserImport.ts listSources/unavailableReason, macOS only: which
// browsers are installed, their profiles, and whether one is running. Read with the app's own file access
// (nsh.json fs.read "/"); injectable, so it is tested on a fake tree. The decrypt-and-read side (H6) is ported in
// browserCookieImport.ts + {chromium,firefox,safari}CookieImport.ts. Still not done here: cookie counts shown in the
// wizard's profile list (BrowserImportWizard.tsx's `cookieCount`), and the Safari Full Disk Access probe used to
// pre-flag `needsFullDiskAccess` before the user opens the wizard (browserCookieImport.ts reports it on the read
// attempt itself instead).
import type { BrowserImportSource } from "../../pages/settings/browserImportWizardLogic";

export interface DetectFs {
  home: string;
  exists: (path: string) => Promise<boolean>;
  readText: (path: string) => Promise<string>;
  readdir: (path: string) => Promise<string[]>;
  readlink: (path: string) => Promise<string>;
}

export type Engine = "chromium" | "firefox" | "safari";
export interface Definition { id: string; name: string; engine: Engine; root: (home: string) => string; keychainService?: string; keychainAccount?: string }

const support = (home: string, ...segments: string[]) => [home, "Library", "Application Support", ...segments].join("/");
/** Keychain service/account per ChromiumKeys.ts's table (OSCrypt's "Safe Storage" key, mac only). */
const chromium = (id: string, name: string, keychainService: string, keychainAccount: string, ...segments: string[]): Definition => ({ id, name, engine: "chromium", root: (home) => support(home, ...segments), keychainService, keychainAccount });

/** BROWSER_IMPORT_SOURCES, in the reference's order, with their macOS data folders. */
export const BROWSER_IMPORT_DEFINITIONS: readonly Definition[] = [
  chromium("chrome", "Chrome", "Chrome Safe Storage", "Chrome", "Google", "Chrome"),
  chromium("edge", "Microsoft Edge", "Microsoft Edge Safe Storage", "Microsoft Edge", "Microsoft Edge"),
  chromium("brave", "Brave", "Brave Safe Storage", "Brave", "BraveSoftware", "Brave-Browser"),
  chromium("vivaldi", "Vivaldi", "Vivaldi Safe Storage", "Vivaldi", "Vivaldi"),
  chromium("opera", "Opera", "Opera Safe Storage", "Opera", "com.operasoftware.Opera"),
  chromium("arc", "Arc", "Arc Safe Storage", "Arc", "Arc", "User Data"),
  chromium("helium", "Helium", "Helium Storage Key", "Helium", "net.imput.helium"),
  { id: "safari", name: "Safari", engine: "safari", root: (home) => `${home}/Library/Containers/com.apple.Safari/Data/Library/Cookies` },
  { id: "firefox", name: "Firefox", engine: "firefox", root: (home) => support(home, "Firefox") },
  { id: "zen", name: "Zen", engine: "firefox", root: (home) => support(home, "zen") },
];

const isSafeProfileDirectory = (d: string) => d.length > 0 && d !== "." && d !== ".." && !/[\\/]/.test(d) && !d.includes("\u0000");
const join = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");

export function cookieCandidates(engine: Engine, root: string, directory: string): string[] {
  const profile = directory.startsWith("/") ? directory : join(root, directory);
  if (engine === "firefox") return [join(profile, "cookies.sqlite")];
  if (engine === "safari") return [join(profile, "Cookies.binarycookies")];
  return [join(profile, "Network", "Cookies"), join(profile, "Cookies")];
}

async function hasCookies(fs: DetectFs, engine: Engine, root: string, directory: string): Promise<boolean> {
  for (const candidate of cookieCandidates(engine, root, directory)) if (await fs.exists(candidate).catch(() => false)) return true;
  return false;
}

/** parseFirefoxProfiles: only [ProfileN] blocks; relative paths may not leave the root. */
export function parseFirefoxProfiles(ini: string): { directory: string; name: string }[] {
  const profiles: { directory: string; name: string }[] = [];
  let current: { name?: string; path?: string; isRelative?: string } | null = null;
  const flush = () => {
    if (current?.path && !current.path.includes("\u0000") && (current.isRelative === undefined || /^[01]$/.test(current.isRelative))) {
      const relative = current.isRelative === undefined || current.isRelative === "1";
      const p = current.path;
      const ok = relative ? !p.startsWith("/") && !p.split("/").includes("..") : p.startsWith("/");
      if (ok) profiles.push({ directory: p, name: current.name?.trim() || p });
    }
    current = null;
  };
  for (const raw of ini.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) { flush(); current = /^\[Profile\d+\]$/i.test(line) ? {} : null; continue; }
    if (!current) continue;
    const at = line.indexOf("=");
    if (at === -1) continue;
    const key = line.slice(0, at).trim().toLowerCase(); const value = line.slice(at + 1).trim();
    if (key === "name") current.name = value;
    if (key === "path") current.path = value;
    if (key === "isrelative") current.isRelative = value;
  }
  flush();
  return profiles;
}

async function listProfiles(fs: DetectFs, def: Definition): Promise<{ directory: string; name: string }[]> {
  const root = def.root(fs.home);
  if (def.engine === "safari") return [{ directory: ".", name: "Safari" }];
  if (def.engine === "firefox") {
    const declared = parseFirefoxProfiles(await fs.readText(join(root, "profiles.ini")).catch(() => ""));
    const withDb: { directory: string; name: string }[] = [];
    for (const profile of declared) if (await hasCookies(fs, def.engine, root, profile.directory)) withDb.push(profile);
    if (withDb.length > 0) return withDb;
    const scanned = await fs.readdir(join(root, "Profiles")).catch(() => [] as string[]);
    const found: { directory: string; name: string }[] = [];
    for (const entry of scanned) if (await hasCookies(fs, def.engine, root, `Profiles/${entry}`)) found.push({ directory: `Profiles/${entry}`, name: entry });
    return found;
  }
  let declared: { directory: string; name: string }[] = [];
  try {
    const state = JSON.parse(await fs.readText(join(root, "Local State"))) as { profile?: { info_cache?: Record<string, { name?: string }> } };
    declared = Object.entries(state.profile?.info_cache ?? {}).filter(([d]) => isSafeProfileDirectory(d)).map(([directory, info]) => ({ directory, name: info?.name?.trim() || directory }));
  } catch { /* no Local State */ }
  if (declared.length > 0) return declared;
  const entries = await fs.readdir(root).catch(() => [] as string[]);
  const found: { directory: string; name: string }[] = [];
  for (const entry of entries.filter(isSafeProfileDirectory)) if (await hasCookies(fs, def.engine, root, entry)) found.push({ directory: entry, name: entry });
  return found;
}

async function isRunning(fs: DetectFs, def: Definition, profiles: { directory: string }[]): Promise<boolean> {
  const root = def.root(fs.home);
  if (def.engine === "safari") return false;
  if (def.engine === "chromium") return fs.readlink(join(root, "SingletonLock")).then(() => true, (e: { code?: string }) => e?.code !== "ENOENT");
  // Firefox: a profile's `lock` symlink (macOS/Linux) marks a running instance.
  for (const profile of profiles) {
    const dir = profile.directory.startsWith("/") ? profile.directory : join(root, profile.directory);
    if (await fs.readlink(join(dir, "lock")).then(() => true, () => false)) return true;
  }
  return false;
}

/** listSources: every definition, with its profiles when it is usable, or why it is not. */
export async function detectBrowserImportSources(fs: DetectFs): Promise<BrowserImportSource[]> {
  const sources: BrowserImportSource[] = [];
  for (const def of BROWSER_IMPORT_DEFINITIONS) {
    const root = def.root(fs.home);
    const profiles = await listProfiles(fs, def);
    let installed = false;
    for (const profile of profiles) if (await hasCookies(fs, def.engine, root, profile.directory)) { installed = true; break; }
    if (!installed) { sources.push({ id: def.id, name: def.name, unavailable: "notInstalled", profiles: [] }); continue; }
    if (await isRunning(fs, def, profiles)) { sources.push({ id: def.id, name: def.name, unavailable: "browserRunning", profiles: [] }); continue; }
    sources.push({ id: def.id, name: def.name, profiles });
  }
  return sources;
}
