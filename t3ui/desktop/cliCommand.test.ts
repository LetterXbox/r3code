import { expect, test } from "nsh/test";
import { activationDirectoryFor, cliCommandDescription, createCliCommand, installCliOnFirstLaunch, MARKER, pathSetup, renderCliShim, CLI_FIRST_LAUNCH_KEY, type CliEnvironment, type CliFs, type FirstLaunchStorage } from "./cliCommand";
import { ACTIVATION_CLIENT_FALLBACK_EXIT_CODE } from "./appActivation";

function memoryStorage(): FirstLaunchStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: async (k) => map.get(k) ?? null, setItem: async (k, v) => { map.set(k, v); } };
}

function memoryFs() {
  const files = new Map<string, { text: string; mode: number }>();
  const links = new Map<string, string>();
  const dirs = new Set<string>(["/h", "/h/.local", "/usr/bin"]);
  const follow = (path: string): string => { let p = path; for (let i = 0; i < 8 && links.has(p); i++) p = links.get(p)!; return p; };
  const fs: CliFs = {
    exists: async (p) => files.has(follow(p)) || dirs.has(p) || links.has(p),
    readText: async (p) => { const f = files.get(follow(p)); if (!f) throw new Error("ENOENT"); return f.text; },
    writeText: async (p, text) => { files.set(p, { text, mode: files.get(p)?.mode ?? 0o644 }); },
    mkdirp: async (p) => { dirs.add(p); },
    rename: async (a, b) => { if (files.has(a)) { files.set(b, files.get(a)!); files.delete(a); } else if (links.has(a)) { links.set(b, links.get(a)!); links.delete(a); } else throw new Error("ENOENT"); },
    unlink: async (p) => { links.delete(p); files.delete(p); },
    readlink: async (p) => { const t = links.get(p); if (t === undefined) throw new Error("EINVAL"); return t; },
    stat: async (p) => { const f = files.get(follow(p)); if (!f) throw new Error("ENOENT"); return { isFile: true, size: f.text.length, mode: f.mode }; },
    isLink: async (p) => links.has(p),
    symlink: async (target, link) => { if (links.has(link) || files.has(link)) throw new Error("EEXIST"); links.set(link, target); },
    chmodExecutable: async (p) => { const f = files.get(p); if (f) f.mode = 0o755; },
  };
  return { fs, files, links };
}

const env = (path = "/usr/bin:/h/.local/bin"): CliEnvironment => ({ home: "/h", t3Home: "/h/.t3codegpui/server", node: "/n/node", entry: "/srv/bin.mjs", path, shell: "/bin/zsh", zdotdir: undefined, configHome: undefined });

test("the launcher script tries a running window's activation hand-off before the server entry", () => {
  const text = renderCliShim({ node: "/n/node", entry: "/srv/bin.mjs", shimPath: "/h/.t3codegpui/server/bin/t3", t3Home: "/h/.t3codegpui/server" });
  expect(text).toContain(`activator='/h/.t3codegpui/server/bin/activate.mjs'`);
  expect(text).toContain('if [ "$1" = "app" ]; then');
  expect(text).toContain(`if [ "$status" != "${ACTIVATION_CLIENT_FALLBACK_EXIT_CODE}" ]; then`);
});

test("the launcher script runs the server entry with the T3 home", () => {
  const text = renderCliShim({ node: "/n/node", entry: "/srv/bin.mjs", shimPath: "/h/.t3codegpui/server/bin/t3", t3Home: "/h/.t3codegpui/server" });
  expect(text).toContain(`# ${MARKER}`);
  expect(text).toContain(`exec "$app" '/srv/bin.mjs' "$@"`);
  expect(text).toContain(`export T3CODE_HOME="\${T3CODE_HOME:-$home}"`);
});

test("install links ~/.local/bin/t3 when it is on PATH, then Remove takes it away", async () => {
  const m = memoryFs();
  const cli = createCliCommand(env(), m.fs, () => 7);
  const before = await cli.state();
  expect(before.installedPath).toBe(null);
  expect(cliCommandDescription(before)).toBe("Run T3 Code's CLI as `t3` from any terminal.");
  const after = await cli.install();
  expect(m.links.get("/h/.local/bin/t3")).toBe("/h/.t3codegpui/server/bin/t3");
  expect(m.files.get("/h/.t3codegpui/server/bin/t3")?.mode).toBe(0o755);
  expect(after.onPath).toBe(true);
  expect(cliCommandDescription(after)).toBe("Installed at /h/.local/bin/t3. Open a new terminal to use it.");
  const activator = m.files.get("/h/.t3codegpui/server/bin/activate.mjs")?.text;
  expect(activator).toContain(`const DIR = "${activationDirectoryFor("/h")}";`);
  const removed = await cli.uninstall();
  expect(removed.installedPath).toBe(null);
  expect(m.links.has("/h/.local/bin/t3")).toBe(false);
});

test("a folder off PATH offers Add to PATH in .zshrc", async () => {
  const m = memoryFs();
  const cli = createCliCommand(env("/usr/bin"), m.fs, () => 7);
  const state = await cli.install();
  expect(state.onPath).toBe(false);
  expect(state.pathSetup).toEqual({ file: "~/.zshrc", added: false });
  const added = await cli.addToPath();
  expect(m.files.get("/h/.zshrc")?.text).toBe('\n# Added by T3 Code\nexport PATH="$PATH:$HOME/.local/bin"\n');
  expect(added.pathSetup?.added).toBe(true);
  expect(cliCommandDescription(added)).toBe("Installed at /h/.local/bin/t3 and added to PATH in ~/.zshrc. Open a new terminal to use it.");
});

test("another t3 first on PATH shadows and blocks install", async () => {
  const m = memoryFs();
  m.files.set("/usr/bin/t3", { text: "#!/bin/sh\necho other\n", mode: 0o755 });
  const cli = createCliCommand(env(), m.fs, () => 7);
  const state = await cli.state();
  expect(state.shadowedBy).toBe("/usr/bin/t3");
  expect(cliCommandDescription(state)).toBe("Another t3 at /usr/bin/t3 runs first in a new terminal. Remove it to use T3 Code's.");
  await expect(cli.install()).rejects.toThrow("Another t3 at /usr/bin/t3 runs first in a new terminal. Remove it, or run the launcher directly at /h/.t3codegpui/server/bin/t3.");
});

test("pathSetup follows the shell", () => {
  expect(pathSetup({ directory: "/h/bin", home: "/h", shell: "/opt/homebrew/bin/fish" })).toEqual({ file: "~/.config/fish/config.fish", line: "fish_add_path --append --path $HOME/bin" });
  expect(pathSetup({ directory: "/h/bin", home: "/h", shell: "/bin/bash" })).toBe(undefined);
});

test("installOnFirstLaunch: no CLI environment (unpackaged dev) never marks and never installs", async () => {
  const storage = memoryStorage();
  const result = await installCliOnFirstLaunch(null, storage);
  expect(result).toEqual({ attempted: false, reason: "no-cli-environment" });
  expect(storage.map.has(CLI_FIRST_LAUNCH_KEY)).toBe(false);
});

test("installOnFirstLaunch: a fresh machine installs once, then never again", async () => {
  const m = memoryFs();
  const storage = memoryStorage();
  const first = await installCliOnFirstLaunch(env(), storage, m.fs);
  expect(first.attempted).toBe(true);
  expect(first.state?.installedPath).toBe("/h/.local/bin/t3");
  expect(storage.map.get(CLI_FIRST_LAUNCH_KEY)).toBe("1");

  await m.fs.unlink("/h/.local/bin/t3");
  const second = await installCliOnFirstLaunch(env(), storage, m.fs);
  expect(second).toEqual({ attempted: false, reason: "already-ran" });
  expect(await m.fs.exists("/h/.local/bin/t3")).toBe(false);
});

test("installOnFirstLaunch: marks before installing, so a failure is never retried", async () => {
  const m = memoryFs();
  const storage = memoryStorage();
  m.files.set("/h/.local/bin", { text: "", mode: 0o644 }); // a plain file, not a directory: mkdirp/symlink both fail here
  const failing: CliFs = { ...m.fs, mkdirp: async () => { throw new Error("EACCES"); } };
  const result = await installCliOnFirstLaunch(env("/usr/bin"), storage, failing);
  expect(result.attempted).toBe(true);
  expect(result.reason).toBeTruthy();
  expect(storage.map.get(CLI_FIRST_LAUNCH_KEY)).toBe("1");
  // Retrying later (another launch) is still a no-op: the marker already stuck.
  expect(await installCliOnFirstLaunch(env("/usr/bin"), storage, m.fs)).toEqual({ attempted: false, reason: "already-ran" });
});

test("installOnFirstLaunch: another t3 already on PATH is left alone, not shadowed by install", async () => {
  const m = memoryFs();
  m.files.set("/usr/bin/t3", { text: "#!/bin/sh\necho other\n", mode: 0o755 });
  const storage = memoryStorage();
  const result = await installCliOnFirstLaunch(env(), storage, m.fs);
  expect(result).toEqual({ attempted: true, state: result.state, reason: "shadowed-by-another-t3" });
  expect(result.state?.shadowedBy).toBe("/usr/bin/t3");
});

test("installOnFirstLaunch: an already-installed link is left as is", async () => {
  const m = memoryFs();
  const storage = memoryStorage();
  await createCliCommand(env(), m.fs).install();
  storage.map.delete(CLI_FIRST_LAUNCH_KEY);
  const result = await installCliOnFirstLaunch(env(), storage, m.fs);
  expect(result.reason).toBe("already-installed");
  expect(result.state?.installedPath).toBe("/h/.local/bin/t3");
});
