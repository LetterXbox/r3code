import { expect, test } from "nsh/test";
import { readAttachmentWith } from "./readAttachment";

function options(maxBytes = 10) {
  return { signal: new AbortController().signal, maxBytes };
}

function dependencies(relativeUrl: string, get: typeof fetch) {
  return {
    endpoint: () => "ws://localhost:1234/ws",
    generation: () => 1,
    mint: async () => ({ relativeUrl }),
    fetch: get,
  };
}

async function failure(promise: Promise<unknown>) {
  try { await promise; return ""; }
  catch (cause) { return cause instanceof Error ? cause.message : String(cause); }
}

test("reads signed same-environment attachment without following redirects", async () => {
  let fetched = "";
  let redirect = "";
  const get = (async (url: string | URL | Request, init?: RequestInit) => {
    fetched = String(url);
    redirect = init?.redirect ?? "";
    return new Response("hello");
  }) as typeof fetch;
  const blob = await readAttachmentWith(dependencies("/api/assets/secret/file.txt", get), "attachment-id", options());
  expect(await blob.text()).toBe("hello");
  expect(fetched).toBe("http://localhost:1234/api/assets/secret/file.txt");
  expect(redirect).toBe("error");
});

test("rejects external and escaped asset URLs without fetching them", async () => {
  let requests = 0;
  const get = (async () => { requests++; return new Response(""); }) as typeof fetch;
  for (const path of ["https://other.test/api/assets/secret/file", "//other.test/api/assets/secret/file", "/api/assets/../private"]) {
    const error = await failure(readAttachmentWith(dependencies(path, get), "id", options()));
    expect(error).toBe("The environment returned an invalid attachment URL.");
  }
  expect(requests).toBe(0);
});

test("stops reading an attachment when its streamed bytes exceed the limit", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5, 6]));
      controller.close();
    },
  });
  const get = (async () => new Response(stream)) as typeof fetch;
  const error = await failure(readAttachmentWith(dependencies("/api/assets/secret/file", get), "id", options(5)));
  expect(error).toBe("The attachment is too large to preview.");
});

test("cancels a pending asset request when the environment changes", async () => {
  let generation = 1;
  const deps = {
    endpoint: () => "ws://localhost:1234/ws",
    generation: () => generation,
    mint: () => new Promise<unknown>(() => {}),
    fetch: (async () => new Response("")) as typeof fetch,
  };
  const pending = readAttachmentWith(deps, "id", options());
  generation = 2;
  const error = await failure(pending);
  expect(error).toBe("Attachment preview cancelled.");
});

test("closing a preview cancels an unfinished response stream", async () => {
  let streamCancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { streamCancelled = true; } });
  const get = (async () => new Response(stream)) as typeof fetch;
  const controller = new AbortController();
  const pending = readAttachmentWith(dependencies("/api/assets/secret/file", get), "id", { signal: controller.signal, maxBytes: 10 });
  setTimeout(() => controller.abort(), 20);
  const error = await failure(pending);
  expect(error).toBe("Attachment preview cancelled.");
  expect(streamCancelled).toBe(true);
});

test("network errors do not expose signed asset URLs", async () => {
  const get = (async () => { throw new Error("http://localhost:1234/api/assets/secret/file"); }) as typeof fetch;
  const error = await failure(readAttachmentWith(dependencies("/api/assets/secret/file", get), "id", options()));
  expect(error).toBe("Attachment preview failed. Retry when the environment is reachable.");
});
