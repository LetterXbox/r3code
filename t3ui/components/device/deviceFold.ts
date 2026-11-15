// deviceFold.ts + deviceHubAtoms.ts (androidFoldReadAtom, androidFoldViewAtom, foldAngle): an Android emulator's fold
// posture over serve-emu's /api/fold (GET reads it, POST {posture} changes it), and the one fold view per device screen
// the fold controls and the 3D phone share. Runs on the app side (no CORS), with the hub access the stream page uses.
import { signal, type Signal } from "nsh";
import { withHubQuery, type DeviceHubAccess } from "./deviceStream";

export type AndroidFoldPosture = "closed" | "opened";

export interface AndroidFoldState {
  readonly supported: boolean;
  readonly posture: "closed" | "half_opened" | "opened" | "flipped" | "tent" | null;
  readonly hingeAngle: number | null;
}

export class AndroidFoldError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "AndroidFoldError"; }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function parseFold(payload: unknown): AndroidFoldState {
  if (!isRecord(payload) || payload.ok !== true || !isRecord(payload.fold)) throw new Error("Unexpected Android fold response.");
  const { supported, posture, hingeAngle } = payload.fold;
  if (
    typeof supported !== "boolean" ||
    (posture !== null && posture !== "closed" && posture !== "half_opened" && posture !== "opened" && posture !== "flipped" && posture !== "tent") ||
    (hingeAngle !== null && (typeof hingeAngle !== "number" || !Number.isFinite(hingeAngle)))
  ) throw new Error("Unexpected Android fold response.");
  return { supported, posture, hingeAngle } as AndroidFoldState;
}

export const foldUrl = (access: DeviceHubAccess, deviceId: string) =>
  withHubQuery(`${access.httpBase}/vendor/serve-emu/api/fold?${new URLSearchParams({ device: deviceId }).toString()}`, access.query);

async function foldRequest(access: DeviceHubAccess, deviceId: string, posture?: AndroidFoldPosture, abort?: AbortSignal, fetcher: typeof fetch = fetch): Promise<AndroidFoldState> {
  const response = await fetcher(foldUrl(access, deviceId), {
    method: posture ? "POST" : "GET",
    cache: "no-store",
    ...(posture ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ posture }) } : {}),
    ...(abort ? { signal: abort } : {}),
  } as RequestInit);
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const error = isRecord(payload) ? payload.error : null;
    throw new AndroidFoldError(typeof error === "string" ? error : `Fold command failed (${response.status}).`, response.status);
  }
  return parseFold(await response.json());
}

export const readAndroidFold = (access: DeviceHubAccess, deviceId: string, abort?: AbortSignal, fetcher?: typeof fetch) => foldRequest(access, deviceId, undefined, abort, fetcher);
export const setAndroidFold = (access: DeviceHubAccess, deviceId: string, posture: AndroidFoldPosture, abort?: AbortSignal, fetcher?: typeof fetch) => foldRequest(access, deviceId, posture, abort, fetcher);

export const FOLD_RETRY_MS = 3_000;
export const FOLD_TIMEOUT_MS = 12_000;

export interface AndroidFoldView {
  readonly fold: AndroidFoldState | null;
  /** Hinge angle the 3D phone shows, including an optimistic one while a change is in flight. */
  readonly angle: number | null;
}

export const foldAngle = (fold: AndroidFoldState | null) => (fold ? fold.hingeAngle ?? (fold.posture === "closed" ? 0 : 180) : null);

/** deviceScreenKey: environment, host and device (not the hub access, so a renewed ticket keeps the known posture). */
export const deviceScreenKey = (environment: string, hostId: string, deviceId: string) => `${environment}\u0000${hostId}\u0000${deviceId}`;

const views = new Map<string, Signal<AndroidFoldView>>();
/** androidFoldViewAtom: one fold view per device screen. */
export function androidFoldView(deviceKey: string): Signal<AndroidFoldView> {
  let view = views.get(deviceKey);
  if (!view) { view = signal<AndroidFoldView>({ fold: null, angle: null }); views.set(deviceKey, view); }
  return view;
}

/**
 * androidFoldReadAtom: reads the fold and records it in the device's fold view, retrying every 3 s; an expired ticket
 * (401) stops retrying. Returns the cancel. The caller starts one read per key (access, device, screen size).
 */
export function startAndroidFoldRead(input: { deviceKey: string; access: DeviceHubAccess; deviceId: string }, deps: { fetcher?: typeof fetch; setTimeout?: typeof setTimeout; clearTimeout?: typeof clearTimeout } = {}): () => void {
  const later = deps.setTimeout ?? setTimeout;
  const cancelLater = deps.clearTimeout ?? clearTimeout;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const attempt = () => {
    void readAndroidFold(input.access, input.deviceId, controller.signal, deps.fetcher).then(
      (fold) => { if (!stopped) androidFoldView(input.deviceKey).set({ fold, angle: fold.supported ? foldAngle(fold) : null }); },
      (cause: unknown) => {
        if (stopped || (cause instanceof AndroidFoldError && cause.status === 401)) return;
        timer = later(attempt, FOLD_RETRY_MS);
      },
    );
  };
  attempt();
  return () => { stopped = true; if (timer) cancelLater(timer); controller.abort(); };
}

/**
 * DeviceAndroidFoldControls' change: optimistic angle, a 12 s timeout, renewed access on 401, then the hub's posture;
 * on failure the angle rolls back and the message is the error to show.
 */
export async function changeAndroidFold(input: { deviceKey: string; access: DeviceHubAccess; deviceId: string; posture: AndroidFoldPosture; renewAccess: () => Promise<DeviceHubAccess | null> }, deps: { fetcher?: typeof fetch; setTimeout?: typeof setTimeout; clearTimeout?: typeof clearTimeout } = {}): Promise<string | null> {
  const view = androidFoldView(input.deviceKey);
  const before = view().fold;
  view.set({ ...view(), angle: input.posture === "closed" ? 0 : 180 });
  const controller = new AbortController();
  const timeout = (deps.setTimeout ?? setTimeout)(() => controller.abort(), FOLD_TIMEOUT_MS);
  const send = (access: DeviceHubAccess) => setAndroidFold(access, input.deviceId, input.posture, controller.signal, deps.fetcher);
  try {
    let next: AndroidFoldState;
    try { next = await send(input.access); }
    catch (cause) {
      // Hub tickets expire after a few minutes, while the panel stays open much longer.
      if (!(cause instanceof AndroidFoldError && cause.status === 401)) throw cause;
      const renewed = await input.renewAccess();
      if (!renewed || controller.signal.aborted) throw cause;
      next = await send(renewed);
    }
    view.set({ fold: next, angle: foldAngle(next) });
    return null;
  } catch (cause) {
    view.set({ ...view(), angle: foldAngle(before) });
    return controller.signal.aborted ? "Fold command timed out." : cause instanceof Error ? cause.message : "Could not change fold posture.";
  } finally {
    (deps.clearTimeout ?? clearTimeout)(timeout);
  }
}
