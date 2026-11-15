import { lstat, readFile, unlink } from "fs/promises";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import { record } from "./client";

export interface AdditionalBootstrapEnvironment {
  id?: string;
  label: string;
  endpoint: string;
  token: string;
}

export interface LocalBootstrap {
  endpoint: string;
  token: string;
  importProviders: boolean;
  serverEngine?: "t3" | "r3";
  additionalEnvironments?: AdditionalBootstrapEnvironment[];
}

function parseLoopbackWsEndpoint(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/ws") {
    throw new Error("Invalid local backend bootstrap");
  }
  return url.toString();
}

/** Parse only loopback endpoints. The token never belongs in the URL. */
export function parseLocalBootstrap(text: string): LocalBootstrap {
  const value = record(JSON.parse(text));
  if (!value || typeof value.endpoint !== "string" || typeof value.token !== "string" || !value.token.trim()) {
    throw new Error("Invalid local backend bootstrap");
  }
  const endpoint = parseLoopbackWsEndpoint(value.endpoint);
  const serverEngine = value.serverEngine === "r3" || value.serverEngine === "t3" ? value.serverEngine : undefined;
  const additionalEnvironments: AdditionalBootstrapEnvironment[] = [];
  if (Array.isArray(value.additionalEnvironments)) {
    for (const item of value.additionalEnvironments) {
      const entry = record(item);
      if (!entry || typeof entry.endpoint !== "string" || typeof entry.token !== "string" || !entry.token.trim()) continue;
      try {
        const extraEndpoint = parseLoopbackWsEndpoint(entry.endpoint);
        const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : new URL(extraEndpoint).host;
        const id = typeof entry.id === "string" && entry.id.startsWith("saved:") ? entry.id : undefined;
        additionalEnvironments.push({ ...(id ? { id } : {}), label, endpoint: extraEndpoint, token: entry.token.trim() });
      } catch {
        /* Skip malformed or non-loopback additional entries. */
      }
    }
  }
  return {
    endpoint,
    token: value.token.trim(),
    importProviders: value.importProviders === true,
    ...(serverEngine ? { serverEngine } : {}),
    ...(additionalEnvironments.length > 0 ? { additionalEnvironments } : {}),
  };
}

/** Consume a launcher-provided, private, one-use file before using its credential. */
export async function consumeLocalBootstrap(file: string): Promise<LocalBootstrap> {
  const root = resolve(join(homedir(), ".t3codegpui", "bootstrap"));
  const path = resolve(file);
  // The main app's file sits in the bootstrap folder; a test copy's in its own folder one level below it (run_local.py).
  const folder = dirname(path);
  const inTestFolder = dirname(folder) === root && /^[A-Za-z0-9._-]+$/.test(basename(folder)) && basename(folder) !== "." && basename(folder) !== "..";
  if ((folder !== root && !inTestFolder) || !/^bootstrap-[a-f0-9-]+\.json$/.test(basename(path))) {
    throw new Error("Invalid local backend bootstrap");
  }
  const directory = await lstat(folder);
  const info = await lstat(path);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 ||
      !info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size < 1 || info.size > 16384) {
    throw new Error("Invalid local backend bootstrap");
  }
  const data = await readFile(path, "utf8");
  await unlink(path);
  return parseLocalBootstrap(data);
}
