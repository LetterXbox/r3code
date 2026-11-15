// DesktopSshPasswordPrompts.ts + SshPasswordPromptDialog.tsx's queue. NSH's process API gives a child no environment
// of its own and no terminal, so ssh cannot be handed an askpass helper per call: the launcher (tools/run_local.py)
// writes one (<data dir>/askpass/t3-askpass) and sets SSH_ASKPASS, SSH_ASKPASS_REQUIRE=force and T3GPUI_ASKPASS_DIR in
// the app's environment, which every ssh child inherits (capabilities.process.env). Batch-mode calls never ask; a
// password attempt (environments/ssh.ts) drops batch mode, ssh runs the helper, the helper writes `<id>.prompt` and
// waits for `<id>.answer` (or `<id>.cancel`), and this module turns the files into the dialog's queue. Answers are
// kept in memory per destination to reuse for that host, never written anywhere but the one-shot answer file the
// helper deletes after reading.
import { exists, readdir, readFile, unlink, writeFile } from "fs/promises";
import { signal } from "nsh";
import process from "process";

export const SSH_PASSWORD_PROMPT_TIMEOUT_MS = 3 * 60 * 1000;
export const EXPIRED_MESSAGE = "This SSH verification prompt expired. Try connecting again.";

export interface SshPasswordPromptRequest {
  requestId: string;
  destination: string;
  username: string | null;
  prompt: string;
  expiresAt: number;
}

export interface PromptFs {
  list(dir: string): Promise<string[]>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

const realFs: PromptFs = {
  list: (dir) => readdir(dir),
  read: (path) => readFile(path, "utf8"),
  write: (path, text) => writeFile(path, text),
  remove: (path) => unlink(path),
  exists: (path) => exists(path),
};

export const askpassDir = (): string | null => process.env.T3GPUI_ASKPASS_DIR || null;
/** Whether a password attempt can ask at all (the launcher set the helper up). */
export const askpassAvailable = () => askpassDir() !== null && Boolean(process.env.SSH_ASKPASS);

export function createSshPasswordPrompts(deps: { dir: string; fs?: PromptFs; now?: () => number }) {
  const fs = deps.fs ?? realFs;
  const now = deps.now ?? (() => Date.now());
  const queue = signal<readonly SshPasswordPromptRequest[]>([]);
  const seen = new Set<string>();
  const remembered = new Map<string, string>();
  /** The connection attempt the next prompts belong to (one at a time, as the reference's connect flow). */
  let current: { destination: string; username: string | null; reused: boolean } | null = null;

  const answer = async (requestId: string, text: string | null) => {
    const base = `${deps.dir}/${requestId}`;
    if (text === null) await fs.write(`${base}.cancel`, "");
    else await fs.write(`${base}.answer`, text);
  };

  const poll = async () => {
    let names: string[];
    try { names = await fs.list(deps.dir); } catch { return; }
    const live = new Set<string>();
    for (const name of names) {
      if (!name.endsWith(".prompt")) continue;
      const requestId = name.slice(0, -".prompt".length);
      live.add(requestId);
      if (seen.has(requestId)) continue;
      seen.add(requestId);
      let prompt = "";
      try { prompt = (await fs.read(`${deps.dir}/${name}`)).trim(); } catch { continue; }
      const target = current ?? { destination: destinationFromPrompt(prompt) ?? "the SSH host", username: null, reused: true };
      const cached = remembered.get(target.destination);
      // A remembered answer goes once per attempt; a second ask means it was wrong.
      if (cached !== undefined && current && !current.reused && /password/i.test(prompt)) {
        current.reused = true;
        await answer(requestId, cached);
        continue;
      }
      if (cached !== undefined) remembered.delete(target.destination);
      queue.set([...queue(), { requestId, destination: target.destination, username: target.username, prompt: prompt || "Password:", expiresAt: now() + SSH_PASSWORD_PROMPT_TIMEOUT_MS }]);
    }
    // The helper gave up (ssh ended): its prompt leaves the queue.
    const kept = queue().filter((request) => live.has(request.requestId) || request.expiresAt <= now());
    if (kept.length !== queue().length) queue.set(kept);
  };

  return {
    queue: () => queue(),
    poll,
    begin(destination: string, username: string | null) { current = { destination, username, reused: false }; },
    end() { current = null; },
    forget(destination: string) { remembered.delete(destination); },
    /** resolveSshPasswordPrompt: null cancels. Throws the expired message for a prompt no longer pending. */
    async resolve(requestId: string, password: string | null) {
      const request = queue().find((item) => item.requestId === requestId);
      if (!request) throw new Error(EXPIRED_MESSAGE);
      if (password !== null && request.expiresAt <= now()) throw new Error(EXPIRED_MESSAGE);
      if (!(await fs.exists(`${deps.dir}/${requestId}.prompt`))) {
        queue.set(queue().filter((item) => item.requestId !== requestId));
        if (password !== null) throw new Error(EXPIRED_MESSAGE);
        return;
      }
      await answer(requestId, password);
      if (password !== null && /password/i.test(request.prompt)) remembered.set(request.destination, password);
      queue.set(queue().filter((item) => item.requestId !== requestId));
    },
    dismiss(requestId: string) { queue.set(queue().filter((item) => item.requestId !== requestId)); },
  };
}

/** "user@host's password:" names its destination. */
export function destinationFromPrompt(prompt: string): string | null {
  const match = /^(?:\(([^)]+)\)\s*)?([^\s@']+@)?([^\s']+)'s password:/i.exec(prompt);
  return match?.[3] ?? null;
}

export function formatRemainingSeconds(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

let instance: ReturnType<typeof createSshPasswordPrompts> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** The app's prompt service; null without the launcher's helper. */
export function sshPasswordPrompts() {
  const dir = askpassDir();
  if (!dir || !askpassAvailable()) return null;
  if (!instance) instance = createSshPasswordPrompts({ dir });
  return instance;
}

/** Polls for prompts while a password attempt runs (and a little after). */
export function watchSshPrompts(active: boolean) {
  const service = sshPasswordPrompts();
  if (!service) return;
  if (active && timer === null) timer = setInterval(() => { void service.poll(); }, 250);
  if (!active && timer !== null) { clearInterval(timer); timer = null; void service.poll(); }
}

