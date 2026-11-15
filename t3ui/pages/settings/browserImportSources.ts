// The browsers the Import from menu offers (`previewBridge.listBrowserImportSources`, desktop's Sources.ts) and the wizard
// session it opens. Reading another browser's cookies takes the desktop shell's Keychain and cookie-database access, which
// a native client has none of, so no source is ever reported: the menu says "No supported browsers found", which is what the
// reference's menu says when every browser is `notInstalled` or `unsupportedPlatform`.
import { platform, signal } from "nsh";
import { exists, readdir, readFile, readlink } from "fs/promises";
import { homedir } from "os";
import { detectBrowserImportSources } from "../../components/browser/browserImportDetect";
import type { BrowserImportSource } from "./browserImportWizardLogic";

/** Null until the menu has asked; the list once it has. */
export const browserImportSources = signal<readonly BrowserImportSource[] | null>(null);
/** The source the wizard is open for, with the environment its cookies are for. */
export const browserImportSession = signal<{ source: BrowserImportSource; environmentName: string } | null>(null);

// Detection (which browsers and profiles exist, which is running) is ported in components/browser/browserImportDetect.ts;
// the import itself still answers "unsupportedPlatform" (BrowserProfiles.tsx onImport): no cookie store to write into.
export async function listBrowserImportSources(): Promise<readonly BrowserImportSource[]> {
  if (platform.os !== "macos") return [];
  return detectBrowserImportSources({
    home: homedir(),
    exists: (path) => exists(path),
    readText: (path) => readFile(path, "utf8"),
    readdir: (path) => readdir(path),
    readlink: (path) => readlink(path),
  });
}

export async function loadBrowserImportSources(): Promise<void> {
  try {
    browserImportSources.set(await listBrowserImportSources());
  } catch {
    browserImportSources.update((previous) => previous ?? []);
  }
}
