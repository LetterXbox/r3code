// Decode-failure log: one JSON line per reply that did not match its contract success schema, appended to
// `<dataDir>/rpc-decode/failures.ndjson` (method, path, issue, time). Always on. Writes are queued; the file is
// read and rewritten (the runtime has no append) and capped at the last 500 lines.
import { mkdir, readFile, writeFile } from "fs/promises";
import process from "process";

const MAX_LINES = 500;
let queue: Promise<void> = Promise.resolve();

export function decodeFailureLogPath(): string | null {
  const dir = process.dataDir;
  return dir ? `${dir}/rpc-decode/failures.ndjson` : null;
}

export function writeDecodeFailure(entry: { method: string; issue: string; at: string }): void {
  const file = decodeFailureLogPath();
  if (!file) return;
  const path = /\n {2}at (.*)$/.exec(entry.issue)?.[1] ?? "";
  const line = JSON.stringify({ at: entry.at, method: entry.method, path, issue: entry.issue.split("\n")[0] });
  queue = queue.then(async () => {
    await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true }).catch(() => undefined);
    let previous = "";
    try { previous = String(await readFile(file, "utf8")); } catch { previous = ""; }
    const lines = [...previous.split("\n").filter(Boolean), line].slice(-MAX_LINES);
    await writeFile(file, `${lines.join("\n")}\n`);
  }).catch((error) => { console.warn("Could not write the RPC decode-failure log", error); });
}
