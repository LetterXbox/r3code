// lib/snapShotSetupResume.ts. The reference keeps it in localStorage, read synchronously; NSH's Storage is async, so the
// value is loaded once at startup into memory (loadSnapShotSetupResume) and written through.
import { effect, Storage } from "nsh";

const STORAGE_KEY = "t3code:snap-shot-setup-resume:v1";
let cached: "enabled" | "disabled" | null = null;

export async function loadSnapShotSetupResume(): Promise<void> {
  try {
    const value = await Storage.getItem(STORAGE_KEY);
    cached = value === "enabled" || value === "disabled" ? value : null;
  } catch { cached = null; }
}

export function readSnapShotSetupResume(): { wasEnabled: boolean } | null {
  return cached ? { wasEnabled: cached === "enabled" } : null;
}

export function saveSnapShotSetupResume(wasEnabled: boolean): void {
  cached = wasEnabled ? "enabled" : "disabled";
  void Storage.setItem(STORAGE_KEY, cached).catch(() => undefined);
}

export function clearSnapShotSetupResume(): void {
  cached = null;
  void Storage.removeItem(STORAGE_KEY).catch(() => undefined);
}

const loaded = loadSnapShotSetupResume();
let startupChecked = false;

/** Checked once per startup so opening System Settings cannot redirect later navigation. */
export function shouldResumeSnapShotSetupOnStartup(): boolean {
  if (startupChecked) return false;
  startupChecked = true;
  return readSnapShotSetupResume() !== null;
}

/** __root.tsx beforeLoad: once the environment is authenticated (connected), a saved resume opens
 * /settings/snap-shot, where SnapShotSettings reopens the wizard at its saved step. */
export function installSnapShotSetupResume(deps: {
  connected: () => boolean;
  currentPath: () => string | null;
  open: (path: string) => void;
}) {
  void loaded.then(() => {
    effect(() => {
      if (!deps.connected() || startupChecked) return;
      if (shouldResumeSnapShotSetupOnStartup() && deps.currentPath() !== "/settings/snap-shot") deps.open("/settings/snap-shot");
    });
  });
}

/** Tests start a fresh startup. */
export function resetSnapShotSetupResumeStartupForTest() { startupChecked = false; }
