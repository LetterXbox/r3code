// AcpSessionManagementSection.tsx's pure parts: reading the server's ACP session and provider payloads
// (packages/contracts/src/acpRegistry.ts) and the write-only headers JSON.
import { rec } from "./logic";

export interface AcpSession { sessionId: string; cwd: string; title: string | null; updatedAt: string | null; importedThreadId: string | null }
export interface AcpConfigurableProvider { providerId: string; supported: string[]; required: boolean; current: { apiType: string; baseUrl: string } | null }
export interface AcpProject { id: string; title: string; workspaceRoot: string }

/** AcpRegistryListSessionsResult: the sessions and the cursor for the next page (null at the end). */
export function parseAcpSessions(value: unknown): { sessions: AcpSession[]; nextCursor: string | null } {
  const result = rec(value);
  const sessions = Array.isArray(result?.sessions) ? result.sessions.flatMap((entry): AcpSession[] => {
    const item = rec(entry);
    if (!item || typeof item.sessionId !== "string") return [];
    return [{ sessionId: item.sessionId, cwd: typeof item.cwd === "string" ? item.cwd : "", title: typeof item.title === "string" ? item.title : null,
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : null, importedThreadId: typeof item.importedThreadId === "string" ? item.importedThreadId : null }];
  }) : [];
  return { sessions, nextCursor: typeof result?.nextCursor === "string" ? result.nextCursor : null };
}

/** AcpRegistryListProvidersResult. */
export function parseAcpProviders(value: unknown): AcpConfigurableProvider[] {
  const result = rec(value);
  return Array.isArray(result?.providers) ? result.providers.flatMap((entry): AcpConfigurableProvider[] => {
    const item = rec(entry);
    if (!item || typeof item.providerId !== "string") return [];
    const current = rec(item.current);
    return [{ providerId: item.providerId, supported: Array.isArray(item.supported) ? item.supported.filter((protocol): protocol is string => typeof protocol === "string") : [], required: item.required === true,
      current: current && typeof current.apiType === "string" && typeof current.baseUrl === "string" ? { apiType: current.apiType, baseUrl: current.baseUrl } : null }];
  }) : [];
}

/** AcpRegistryImportSessionResult. */
export function parseAcpImport(value: unknown): { threadId: string; imported: boolean } {
  const result = rec(value);
  return { threadId: typeof result?.threadId === "string" ? result.threadId : "", imported: result?.imported === true };
}

export function parseProviderHeaders(text: string): { ok: true; headers: Record<string, string> | undefined } | { ok: false; error: string } {
  if (text.trim().length === 0) return { ok: true, headers: undefined };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Headers must be valid JSON." }; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !Object.values(parsed).every((value) => typeof value === "string")) {
    return { ok: false, error: "Headers must be a JSON object with string values." };
  }
  return { ok: true, headers: parsed as Record<string, string> };
}

export interface AcpDraft { apiType: string; baseUrl: string; headers: string }
export function initialDraft(provider: AcpConfigurableProvider): AcpDraft {
  return { apiType: provider.current?.apiType ?? provider.supported[0] ?? "", baseUrl: provider.current?.baseUrl ?? "", headers: "" };
}

/** Which of the three blocks the section shows; none means it renders nothing. */
export function acpSectionCapabilities(provider: { nativeSessions?: { canList: boolean; canLoad: boolean; canResume: boolean; canDelete: boolean }; configurableProviders?: boolean; auth: { canLogout: boolean | null }; setup: { canAuthenticate: boolean | null } }) {
  const canList = provider.nativeSessions?.canList === true;
  const canImport = provider.nativeSessions?.canLoad === true || provider.nativeSessions?.canResume === true;
  const canLogout = provider.auth.canLogout === true && !provider.setup.canAuthenticate;
  const canDelete = provider.nativeSessions?.canDelete === true;
  const canConfigureProviders = provider.configurableProviders === true;
  return { canList, canImport, canLogout, canDelete, canConfigureProviders, visible: canList || canLogout || canConfigureProviders };
}
