import { record, RequestFailure } from "./client";

export type ProviderAuthPhase = "idle" | "starting" | "waiting" | "verifying" | "succeeded" | "failed" | "cancelled";
export type ProviderInstallPhase = "idle" | "downloading" | "extracting" | "verifying" | "succeeded" | "failed" | "cancelled";

export interface ProviderAuthMethod {
  id: string; name: string; description: string | null; type: "agent" | "terminal" | "credentials";
  accountEmail?: string; canRemove?: boolean;
}
export type ProviderAuthInteraction =
  | { type: "browser"; id: string; url: string; requiresConsent: boolean; acceptsCallback?: boolean }
  | { type: "deviceCode"; id: string; url: string; userCode: string }
  | { type: "terminal"; id: string; output: string; outputOffset?: number }
  | { type: "credentials"; id: string; fields: { name: string; label: string; secret: boolean }[] }
  | { type: "unsupported" };
export type ProviderAuthResponse =
  | { type: "browser"; action: "accept" | "decline" }
  | { type: "terminal"; data: string; size?: { cols: number; rows: number } }
  | { type: "credentials"; values: Record<string, string> };
export interface ProviderAuthState {
  instanceId: string; phase: ProviderAuthPhase; flowId: string | null; authorizationUrl: string | null;
  expiresAt: string | null; message: string | null; methods: ProviderAuthMethod[];
  interaction: ProviderAuthInteraction | null; credentialOwner?: "provider" | "t3";
}
export interface ProviderInstallState {
  driver: string; operationId: string | null; phase: ProviderInstallPhase; downloadedBytes: number; totalBytes: number | null;
  version: string | null; installedVersion: string | null; executablePath?: string | null;
  source?: "managed" | "local" | null; canRemove: boolean; message: string | null;
}
export interface ProviderAuthStartOptions { methodId?: string; returnUrl?: string; callbackMode?: "server" | "client" }

export interface ProviderSetupTransport {
  request(method: string, input: unknown): Promise<unknown>;
  subscribe(method: string, input: unknown, onValue: (value: unknown) => void, onError: (error: Error) => void): () => void;
  generation(): number;
}

function operationId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128;
}
function instanceId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value);
}
function nullableString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("Invalid provider setup state");
  return value;
}
function isAuthPhase(value: unknown): value is ProviderAuthPhase {
  return value === "idle" || value === "starting" || value === "waiting" || value === "verifying" || value === "succeeded" || value === "failed" || value === "cancelled";
}
function isInstallPhase(value: unknown): value is ProviderInstallPhase {
  return value === "idle" || value === "downloading" || value === "extracting" || value === "verifying" || value === "succeeded" || value === "failed" || value === "cancelled";
}
function methodFromValue(value: unknown): ProviderAuthMethod | null {
  const method = record(value);
  if (!method || !operationId(method.id) || typeof method.name !== "string" || !method.name.trim() ||
      (method.type !== "agent" && method.type !== "terminal" && method.type !== "credentials")) return null;
  if (method.description !== null && typeof method.description !== "string") return null;
  return { id: method.id, name: method.name, description: method.description, type: method.type,
    ...(typeof method.accountEmail === "string" ? { accountEmail: method.accountEmail } : {}),
    ...(typeof method.canRemove === "boolean" ? { canRemove: method.canRemove } : {}) };
}
function interactionFromValue(value: unknown): ProviderAuthInteraction | null {
  if (value == null) return null;
  const item = record(value);
  if (!item || !operationId(item.id)) return { type: "unsupported" };
  if (item.type === "browser" && typeof item.url === "string" && item.url.trim() && item.url.length <= 16384 && typeof item.requiresConsent === "boolean") {
    return { type: "browser", id: item.id, url: item.url, requiresConsent: item.requiresConsent,
      ...(typeof item.acceptsCallback === "boolean" ? { acceptsCallback: item.acceptsCallback } : {}) };
  }
  if (item.type === "deviceCode" && typeof item.url === "string" && item.url.trim() && item.url.length <= 16384 &&
      typeof item.userCode === "string" && item.userCode.trim() && item.userCode.length <= 256) {
    return { type: "deviceCode", id: item.id, url: item.url, userCode: item.userCode };
  }
  if (item.type === "terminal" && typeof item.output === "string" && item.output.length <= 16384 &&
      (item.outputOffset === undefined || (Number.isSafeInteger(item.outputOffset) && typeof item.outputOffset === "number" && item.outputOffset >= 0))) {
    return { type: "terminal", id: item.id, output: item.output,
      ...(typeof item.outputOffset === "number" ? { outputOffset: item.outputOffset } : {}) };
  }
  if (item.type === "credentials" && Array.isArray(item.fields) && item.fields.length <= 16) {
    const fields = item.fields.map(record).flatMap((field) => field && operationId(field.name) && typeof field.label === "string" &&
      field.label.trim() && typeof field.secret === "boolean" ? [{ name: field.name, label: field.label, secret: field.secret }] : []);
    if (fields.length === item.fields.length) return { type: "credentials", id: item.id, fields };
  }
  return { type: "unsupported" };
}

export function parseProviderAuthState(value: unknown, expectedInstanceId: string): ProviderAuthState {
  const state = record(value);
  if (!state || state.instanceId !== expectedInstanceId || !isAuthPhase(state.phase) ||
      (state.flowId != null && !operationId(state.flowId))) throw new Error("Invalid provider authentication state");
  const methods = state.methods === undefined ? [] : Array.isArray(state.methods) && state.methods.length <= 32
    ? state.methods.map(methodFromValue).filter((method): method is ProviderAuthMethod => method !== null) : null;
  if (!methods) throw new Error("Invalid provider authentication state");
  return { instanceId: expectedInstanceId, phase: state.phase, flowId: state.flowId == null ? null : state.flowId,
    authorizationUrl: nullableString(state.authorizationUrl), expiresAt: nullableString(state.expiresAt), message: nullableString(state.message),
    methods, interaction: interactionFromValue(state.interaction),
    ...(state.credentialOwner === "provider" || state.credentialOwner === "t3" ? { credentialOwner: state.credentialOwner } : {}) };
}

export function parseProviderInstallState(value: unknown): ProviderInstallState {
  const state = record(value);
  if (!state || !instanceId(state.driver) || !isInstallPhase(state.phase) ||
      (state.operationId != null && !operationId(state.operationId)) ||
      typeof state.downloadedBytes !== "number" || !Number.isSafeInteger(state.downloadedBytes) || state.downloadedBytes < 0 ||
      (state.totalBytes != null && (typeof state.totalBytes !== "number" || !Number.isSafeInteger(state.totalBytes) || state.totalBytes < 0)) ||
      typeof state.canRemove !== "boolean") throw new Error("Invalid provider installation state");
  const source = state.source;
  if (source !== undefined && source !== null && source !== "managed" && source !== "local") throw new Error("Invalid provider installation state");
  return { driver: state.driver, operationId: state.operationId == null ? null : state.operationId, phase: state.phase,
    downloadedBytes: state.downloadedBytes, totalBytes: state.totalBytes == null ? null : state.totalBytes,
    version: nullableString(state.version), installedVersion: nullableString(state.installedVersion), canRemove: state.canRemove,
    message: nullableString(state.message), ...(state.executablePath !== undefined ? { executablePath: nullableString(state.executablePath) } : {}),
    ...(source !== undefined ? { source } : {}) };
}

/** Safe for a user-initiated browser open; never opens the URL itself. */
export function isSafeProviderAuthUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) &&
      !url.username && !url.password;
  } catch { return false; }
}

function validateResponse(response: ProviderAuthResponse): void {
  if (response.type === "browser" && (response.action === "accept" || response.action === "decline")) return;
  if (response.type === "terminal" && typeof response.data === "string" && response.data.length <= 4096 &&
      (!response.size || (Number.isSafeInteger(response.size.cols) && response.size.cols >= 1 && response.size.cols <= 500 &&
        Number.isSafeInteger(response.size.rows) && response.size.rows >= 1 && response.size.rows <= 200))) return;
  if (response.type === "credentials" && record(response.values)) {
    const fields = Object.entries(response.values);
    if (fields.length <= 16 && fields.every(([name, value]) => operationId(name) && typeof value === "string" && value.length <= 16384)) return;
  }
  throw new Error("Invalid provider authentication response");
}

export class ProviderSetupClient {
  constructor(private readonly transport: ProviderSetupTransport) {}

  private async request<T>(method: string, input: unknown, parse: (value: unknown) => T, failure: string): Promise<T> {
    const generation = this.transport.generation();
    let value: unknown;
    try { value = await this.transport.request(method, input); }
    catch (error) {
      if (generation !== this.transport.generation()) throw new Error("The environment changed during provider setup");
      if (error instanceof Error && error.message === "Connect an environment first") throw new Error(error.message);
      // ProviderSetupError.detail is documented as safe setup failure text; the reference shows it (failure.message).
      if (error instanceof RequestFailure && (error.tag === "ProviderSetupError" || error.tag === "EnvironmentAuthorizationError") &&
          error.message.trim() && error.message !== "Request failed") throw new Error(error.message);
      if (error instanceof Error && error.message.startsWith("Request timed out")) {
        throw new Error("Provider setup timed out. Check its current status before retrying.");
      }
      throw new Error(failure);
    }
    if (generation !== this.transport.generation()) throw new Error("The environment changed during provider setup");
    try { return parse(value); }
    catch { throw new Error("The environment returned an invalid provider setup state"); }
  }

  private subscribe<T>(method: string, id: string, parse: (value: unknown) => T, onValue: (value: T) => void, onError: (error: Error) => void): () => void {
    if (!instanceId(id)) { onError(new Error("Invalid provider instance")); return () => {}; }
    const generation = this.transport.generation();
    let active = true;
    let dispose: (() => void) | undefined;
    let disposeWhenReady = false;
    // formatEnvironmentQueryError: the stream's own error message, else "The environment request failed.".
    const fail = (cause?: unknown) => {
      if (!active || generation !== this.transport.generation()) return;
      active = false;
      if (dispose) dispose(); else disposeWhenReady = true;
      const message = cause instanceof Error ? cause.message.trim() : "";
      onError(new Error(message && message !== "Request failed" ? message : "The environment request failed."));
    };
    try {
      dispose = this.transport.subscribe(method, { instanceId: id }, (value) => {
        if (!active || generation !== this.transport.generation()) return;
        let parsed: T;
        try { parsed = parse(value); } catch { fail(new Error("The environment returned an invalid provider setup state")); return; }
        onValue(parsed);
      }, (error) => fail(error));
    } catch (error) { fail(error); }
    if (disposeWhenReady) dispose?.();
    return () => { active = false; dispose?.(); };
  }

  subscribeAuth(id: string, onState: (state: ProviderAuthState) => void, onError: (error: Error) => void): () => void {
    return this.subscribe("provider.auth.subscribe", id, (value) => parseProviderAuthState(value, id), onState, onError);
  }
  subscribeInstall(id: string, onState: (state: ProviderInstallState) => void, onError: (error: Error) => void): () => void {
    return this.subscribe("provider.install.subscribe", id, parseProviderInstallState, onState, onError);
  }
  startAuth(id: string, options: ProviderAuthStartOptions = {}): Promise<ProviderAuthState> {
    if (!instanceId(id) || (options.methodId !== undefined && !operationId(options.methodId)) ||
        (options.returnUrl !== undefined && (typeof options.returnUrl !== "string" || options.returnUrl.length > 16384)) ||
        (options.callbackMode !== undefined && options.callbackMode !== "server" && options.callbackMode !== "client")) {
      return Promise.reject(new Error("Invalid provider authentication request"));
    }
    return this.authRequest("provider.auth.start", id, { instanceId: id, ...options });
  }
  respondAuth(id: string, flowId: string, interactionId: string, response: ProviderAuthResponse): Promise<ProviderAuthState> {
    if (!instanceId(id) || !operationId(flowId) || !operationId(interactionId)) return Promise.reject(new Error("Invalid provider authentication request"));
    try { validateResponse(response); } catch { return Promise.reject(new Error("Invalid provider authentication response")); }
    return this.authRequest("provider.auth.respond", id, { instanceId: id, flowId, interactionId, response });
  }
  completeAuth(id: string, flowId: string, callbackUrl: string): Promise<ProviderAuthState> {
    if (!instanceId(id) || !operationId(flowId) || typeof callbackUrl !== "string" || !callbackUrl.trim() || callbackUrl.length > 16384) {
      return Promise.reject(new Error("Invalid provider authentication request"));
    }
    return this.authRequest("provider.auth.complete", id, { instanceId: id, flowId, callbackUrl });
  }
  cancelAuth(id: string, flowId: string): Promise<ProviderAuthState> {
    if (!instanceId(id) || !operationId(flowId)) return Promise.reject(new Error("Invalid provider authentication request"));
    return this.authRequest("provider.auth.cancel", id, { instanceId: id, flowId });
  }
  logout(id: string): Promise<ProviderAuthState> {
    if (!instanceId(id)) return Promise.reject(new Error("Invalid provider instance"));
    return this.authRequest("provider.auth.logout", id, { instanceId: id });
  }
  removeAuthMethod(id: string, methodId: string): Promise<ProviderAuthState> {
    if (!instanceId(id) || !operationId(methodId)) return Promise.reject(new Error("Invalid provider authentication request"));
    return this.authRequest("provider.auth.removeMethod", id, { instanceId: id, methodId });
  }
  private authRequest(method: string, id: string, input: unknown): Promise<ProviderAuthState> {
    return this.request(method, input, (value) => parseProviderAuthState(value, id), "Provider authentication failed. Try again.");
  }
  startInstall(id: string): Promise<ProviderInstallState> {
    if (!instanceId(id)) return Promise.reject(new Error("Invalid provider instance"));
    return this.installRequest("provider.install.start", { instanceId: id });
  }
  cancelInstall(id: string, operationIdValue: string): Promise<ProviderInstallState> {
    if (!instanceId(id) || !operationId(operationIdValue)) return Promise.reject(new Error("Invalid provider installation request"));
    return this.installRequest("provider.install.cancel", { instanceId: id, operationId: operationIdValue });
  }
  removeInstall(id: string): Promise<ProviderInstallState> {
    if (!instanceId(id)) return Promise.reject(new Error("Invalid provider instance"));
    return this.installRequest("provider.install.remove", { instanceId: id });
  }
  private installRequest(method: string, input: unknown): Promise<ProviderInstallState> {
    return this.request(method, input, parseProviderInstallState, "Provider installation failed. Try again.");
  }
}
