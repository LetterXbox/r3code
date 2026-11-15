import { backendConnectionGeneration, backendUrl, requestBackend } from "../../store";
import { environmentGeneration, managedEnvironment, parseScopedKey, requestEnvironment } from "../../environments/connectionManager";

type ReaderDependencies = {
  endpoint: () => string;
  generation: () => number | string;
  mint: (id: string) => Promise<unknown>;
  fetch: typeof fetch;
};

class PreviewError extends Error {}

function assetUrl(endpoint: string, relativeUrl: unknown): string {
  if (typeof relativeUrl !== "string" || !relativeUrl.startsWith("/api/assets/") || relativeUrl.startsWith("//")) {
    throw new PreviewError("The environment returned an invalid attachment URL.");
  }
  try {
    const base = new URL(endpoint);
    if (base.protocol !== "ws:" && base.protocol !== "wss:" && base.protocol !== "http:" && base.protocol !== "https:") throw new Error();
    base.protocol = base.protocol === "wss:" || base.protocol === "https:" ? "https:" : "http:";
    base.pathname = "/";
    base.search = "";
    base.hash = "";
    const target = new URL(relativeUrl, base);
    if (target.origin !== base.origin || !target.pathname.startsWith("/api/assets/")) throw new Error();
    return target.toString();
  } catch {
    throw new PreviewError("The environment returned an invalid attachment URL.");
  }
}

/** Read a temporary signed asset without exposing its URL to the UI or browser. */
export async function readAttachmentWith(
  dependencies: ReaderDependencies,
  attachmentId: string,
  options: { signal: AbortSignal; maxBytes: number },
): Promise<Blob> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) throw new PreviewError("Invalid preview size limit.");
  if (options.signal.aborted) throw new PreviewError("Attachment preview cancelled.");
  const generation = dependencies.generation();
  const endpoint = dependencies.endpoint();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const checkGeneration = () => { if (dependencies.generation() !== generation) cancel(); };
  options.signal.addEventListener("abort", cancel);
  if (options.signal.aborted) cancel();
  const timer = setInterval(checkGeneration, 100);
  let rejectAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new PreviewError("Attachment preview cancelled."));
    controller.signal.addEventListener("abort", rejectAbort);
    if (controller.signal.aborted) rejectAbort();
  });
  try {
    const minted = await Promise.race([dependencies.mint(attachmentId), cancelled]);
    checkGeneration();
    if (controller.signal.aborted) throw new PreviewError("Attachment preview cancelled.");
    const relativeUrl = minted && typeof minted === "object" && "relativeUrl" in minted ? minted.relativeUrl : null;
    const target = assetUrl(endpoint, relativeUrl);
    const response = await Promise.race([dependencies.fetch(target, { redirect: "error", signal: controller.signal }), cancelled]);
    if (response.redirected) throw new PreviewError("The environment redirected the attachment request.");
    if (!response.ok) throw new PreviewError(`Attachment preview failed (HTTP ${response.status}).`);
    const length = response.headers.get("content-length");
    if (length && Number(length) > options.maxBytes) throw new PreviewError("The attachment is too large to preview.");
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const result = await Promise.race([reader.read(), cancelled]);
          checkGeneration();
          if (controller.signal.aborted) throw new PreviewError("Attachment preview cancelled.");
          if (result.done) break;
          total += result.value.byteLength;
          if (total > options.maxBytes) throw new PreviewError("The attachment is too large to preview.");
          chunks.push(result.value);
        }
      } finally {
        if (controller.signal.aborted || total > options.maxBytes) void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    return new Blob(chunks);
  } catch (cause) {
    if (cause instanceof PreviewError) throw cause;
    throw new PreviewError("Attachment preview failed. Retry when the environment is reachable.");
  } finally {
    clearInterval(timer);
    options.signal.removeEventListener("abort", cancel);
    if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
    controller.abort();
  }
}

export function readAttachment(attachmentId: string, options: { signal: AbortSignal; maxBytes: number }): Promise<Blob> {
  return readAttachmentWith({
    endpoint: backendUrl,
    generation: backendConnectionGeneration,
    mint: (id) => requestBackend("assets.createUrl", { resource: { _tag: "attachment", attachmentId: id } }),
    fetch,
  }, attachmentId, options);
}

/** Read an attachment from the environment that owns its conversation. */
export function readThreadAttachment(threadId: string | null | undefined, attachmentId: string, options: { signal: AbortSignal; maxBytes: number }): Promise<Blob> {
  const scoped = threadId ? parseScopedKey(threadId) : null;
  if (!scoped) return readAttachment(attachmentId, options);
  const environmentId = scoped.environmentId;
  return readAttachmentWith({
    endpoint: () => managedEnvironment(environmentId)?.url ?? "",
    generation: () => environmentGeneration(environmentId),
    mint: (id) => requestEnvironment(environmentId, "assets.createUrl", { resource: { _tag: "attachment", attachmentId: id } }),
    fetch,
  }, attachmentId, options);
}
