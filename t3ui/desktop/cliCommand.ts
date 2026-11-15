// apps/desktop/src/app/DesktopCliCommand.ts + DesktopCliShim.ts (macOS paths), 1:1 in behaviour: Settings > About's
// "t3 command" row installs a `t3` link in ~/.local/bin or ~/bin to this install's launcher (<T3 home>/bin/t3, a shell
// script marked as T3 Code's that runs the app's own server CLI), removes it again, and can add the link's folder to
// PATH in the shell's startup file. The launcher (tools/run_local.py) tells the app where its node, server entry and
// T3 home are, and the login shell's PATH (T3GPUI_CLI_*, T3GPUI_LOGIN_PATH); without them the row is not shown, as the
// reference hides it in an unpackaged app. Links go through /bin/ln (NSH's fs has no symlink), modes through /bin/chmod.
import { exists, lstat, mkdir, readFile, readlink, rename, stat, unlink, writeFile } from "fs/promises";
import process from "process";
import { desktop } from "./runtime";
import { ACTIVATION_CLIENT_FALLBACK_EXIT_CODE, renderActivationClientScript } from "./appActivation";

/** `~/.t3codegpui/activation`: writable per nsh.json's `capabilities.fs.write` entry for `${homeDir}/.t3codegpui` (see
 * appActivation.ts for why this is a directory, not a socket). */
export const activationDirectoryFor = (home: string) => join(join(home, ".t3codegpui"), "activation");

export const MARKER = "Written by T3 Code: runs the desktop app's bundled t3 CLI.";
const MOVED = "T3 Code has moved or been removed. Open the app once to update this command.";

export interface CliCommandState {
  supported: boolean;
  installedPath: string | null;
  onPath: boolean;
  launcherPath: string | null;
  shadowedBy?: string;
  pathSetup?: { file: string; added: boolean };
}

export interface CliFs {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readlink(path: string): Promise<string>;
  /** Follows links. */
  stat(path: string): Promise<{ isFile: boolean; size: number; mode: number }>;
  isLink(path: string): Promise<boolean>;
  symlink(target: string, link: string): Promise<void>;
  chmodExecutable(path: string): Promise<void>;
}

export interface CliEnvironment {
  home: string;
  t3Home: string;
  node: string;
  entry: string;
  path: string;
  shell: string | undefined;
  zdotdir: string | undefined;
  configHome: string | undefined;
}

export class CliCommandError extends Error {}

const realFs: CliFs = {
  exists: (path) => exists(path),
  readText: (path) => readFile(path, "utf8"),
  writeText: (path, text) => writeFile(path, text),
  mkdirp: (path) => mkdir(path, { recursive: true }),
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
  readlink: (path) => readlink(path),
  stat: async (path) => { const s = await stat(path); return { isFile: s.isFile(), size: s.size, mode: s.mode }; },
  isLink: async (path) => { try { return (await lstat(path)).isSymbolicLink(); } catch { return false; } },
  symlink: async (target, link) => {
    const done = await process.run("/bin/ln", ["-s", target, link], { timeoutMs: 10_000 });
    if (done.code !== 0) throw new Error(done.stderr || "ln failed");
  },
  chmodExecutable: async (path) => {
    const done = await process.run("/bin/chmod", ["755", path], { timeoutMs: 10_000 });
    if (done.code !== 0) throw new Error(done.stderr || "chmod failed");
  },
};

export function cliEnvironmentFromProcess(): CliEnvironment | null {
  const env = process.env;
  const t3Home = env.T3GPUI_CLI_HOME;
  const node = env.T3GPUI_CLI_NODE;
  const entry = env.T3GPUI_CLI_ENTRY;
  const home = env.HOME;
  if (!t3Home || !node || !entry || !home) return null;
  return { home, t3Home, node, entry, path: env.T3GPUI_LOGIN_PATH || env.PATH || "", shell: env.SHELL || undefined, zdotdir: env.ZDOTDIR || undefined, configHome: env.XDG_CONFIG_HOME || undefined };
}

const shellWord = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** renderCliShim, the "direct" target: node runs the server entry. Before that, DesktopAppActivation's hand-off:
 * `t3 <path>` or `t3 app [path]` first tries `activate.mjs` (ensureLauncher writes it beside this shim, since a
 * `/bin/sh` script cannot import appActivation.ts). Exit code 3 (ACTIVATION_CLIENT_FALLBACK_EXIT_CODE) means
 * nothing is listening, so this falls through to launching the server directly, same as before; any other exit
 * means a running window already answered (success or a reported failure) and must not be raced with a second
 * launch. Any other `t3` subcommand (not a path, not `app`) is untouched. */
export function renderCliShim(input: { node: string; entry: string; shimPath: string; t3Home: string }): string {
  return [
    "#!/bin/sh",
    `# ${MARKER}`,
    `export T3CODE_CLI_PATH=${shellWord(input.shimPath)}`,
    `home=${shellWord(input.t3Home)}`,
    'export T3CODE_HOME="${T3CODE_HOME:-$home}"',
    `app=${shellWord(input.node)}`,
    'if [ ! -x "$app" ]; then',
    `  echo "${MOVED}" >&2`,
    "  exit 127",
    "fi",
    'target=""',
    'if [ "$1" = "app" ]; then',
    '  target="${2:-$PWD}"',
    'elif [ $# -ge 1 ] && { [ -d "$1" ] || [ -f "$1" ]; }; then',
    '  target="$1"',
    "fi",
    `activator=${shellWord(join(join(input.t3Home, "bin"), "activate.mjs"))}`,
    'if [ -n "$target" ] && [ -f "$activator" ]; then',
    '  "$app" "$activator" "$target" "$(uname -s)"',
    "  status=$?",
    `  if [ "$status" != "${ACTIVATION_CLIENT_FALLBACK_EXIT_CODE}" ]; then`,
    "    exit \"$status\"",
    "  fi",
    "fi",
    `exec "$app" ${shellWord(input.entry)} "$@"`,
    "",
  ].join("\n");
}

/** shared/shell.ts pathSetup (macOS). */
export function pathSetup(input: { directory: string; home: string; shell: string | undefined; configHome?: string; zdotdir?: string }): { file: string; line: string } | undefined {
  if (!input.directory.startsWith("/")) return undefined;
  const underHome = input.directory.startsWith(`${input.home}/`);
  const rest = underHome ? input.directory.slice(input.home.length) : input.directory;
  if (!/^[\w./-]+$/.test(rest)) return undefined;
  const directory = underHome ? `$HOME${rest}` : rest;
  const shell = input.shell?.split("/").pop();
  const readFrom = (value: string | undefined, fallback: string) =>
    !value ? fallback : value.startsWith("/") && /^[\w./-]+$/.test(value) ? value : undefined;
  if (shell === "fish") {
    const configHome = readFrom(input.configHome, "~/.config");
    if (configHome === undefined) return undefined;
    return { file: `${configHome}/fish/config.fish`, line: `fish_add_path --append --path ${directory}` };
  }
  const zdotdir = readFrom(input.zdotdir, "~");
  const file = shell === "zsh" ? zdotdir && `${zdotdir}/.zshrc` : undefined;
  return file === undefined ? undefined : { file, line: `export PATH="$PATH:${directory}"` };
}

const dirname = (path: string) => path.replace(/\/[^/]*$/, "") || "/";
const join = (dir: string, name: string) => `${dir.replace(/\/+$/, "")}/${name}`;
const pathEntries = (value: string) => value.split(":").filter((entry) => entry.length > 0);

export function createCliCommand(env: CliEnvironment, fs: CliFs = realFs, random: () => number = () => Math.floor(Math.random() * 0xffffff)) {
  const launcher = join(join(env.t3Home, "bin"), "t3");
  const userCandidates = [join(env.home, ".local/bin"), join(env.home, "bin")];
  const knownLocations = [...userCandidates, "/opt/homebrew/bin", "/usr/local/bin"];
  const fail = (message: string) => new CliCommandError(message);
  const safe = async <T>(f: () => Promise<T>, fallback: T): Promise<T> => { try { return await f(); } catch { return fallback; } };

  const readsMarker = (path: string) => safe(async () => {
    const info = await fs.stat(path);
    if (!info.isFile || info.size > 16_384) return false;
    return (await fs.readText(path)).includes(MARKER);
  }, false);
  const isOurLink = (link: string) => safe(async () => { await fs.readlink(link); return readsMarker(link); }, false);
  /** Where a path leads (one link deep is what the app writes; deeper chains are followed). */
  const resolve = async (path: string): Promise<string> => {
    let current = path;
    for (let i = 0; i < 8 && (await fs.isLink(current)); i++) {
      const target = await fs.readlink(current);
      current = target.startsWith("/") ? target : join(dirname(current), target);
    }
    return current;
  };
  const runsOurLauncher = (candidate: string) => safe(async () => (await resolve(candidate)) === (await resolve(launcher)) && readsMarker(candidate), false);
  const isExecutableFile = (target: string) => safe(async () => { const info = await fs.stat(target); return info.isFile && (info.mode & 0o111) !== 0; }, false);
  const firstOnPath = async () => {
    for (const directory of pathEntries(env.path)) {
      const candidate = join(directory, "t3");
      if (await isExecutableFile(candidate)) return candidate;
    }
    return null;
  };
  const foreignFirstOnPath = async () => {
    const first = await firstOnPath();
    if (first === null || (await runsOurLauncher(first))) return null;
    return first;
  };
  const leadsHere = (link: string) => safe(async () => (await fs.readlink(link)) === launcher, false);
  const installedAt = async () => {
    for (const directory of knownLocations) {
      const link = join(directory, "t3");
      if (await isOurLink(link)) return link;
    }
    return null;
  };
  const startupLine = (installedPath: string) => {
    const setup = pathSetup({ directory: dirname(installedPath), home: env.home, shell: env.shell, configHome: env.configHome, zdotdir: env.zdotdir });
    if (setup === undefined) return undefined;
    const file = setup.file.startsWith("~/") ? join(env.home, setup.file.slice(2)) : setup.file;
    return { ...setup, path: file };
  };
  const hasLine = (setup: { path: string; line: string }) => safe(async () => (await fs.readText(setup.path)).split("\n").some((line) => line.trim() === setup.line), false);
  const folderOnPath = (link: string) => pathEntries(env.path).some((entry) => entry.replace(/\/+$/, "") === dirname(link));

  const state = async (): Promise<CliCommandState> => {
    try {
      const launcherPath = (await fs.exists(launcher)) ? launcher : null;
      const found = await installedAt();
      const installed = found !== null && (await leadsHere(found)) ? found : null;
      const foreign = await foreignFirstOnPath();
      const shadowedBy = foreign !== null && foreign !== found ? foreign : null;
      const first = await firstOnPath();
      const onPath = first !== null && (await runsOurLauncher(first));
      const setup = onPath || shadowedBy !== null || installed === null || folderOnPath(installed) ? undefined : startupLine(installed);
      return {
        supported: true,
        installedPath: installed,
        onPath,
        launcherPath,
        ...(shadowedBy === null ? {} : { shadowedBy }),
        ...(setup === undefined ? {} : { pathSetup: { file: setup.file, added: await hasLine(setup) } }),
      };
    } catch {
      return { supported: false, installedPath: null, onPath: false, launcherPath: null };
    }
  };

  /** DesktopCliShim.install: (re)writes the launcher unless something else is there. Also (re)writes the
   * activation hand-off script beside it: best effort only, since the launcher itself is what `t3` actually needs
   * to work, and a `t3` that falls straight through to launching the server is still correct, just never hands off
   * to a running window. */
  const ensureLauncher = async () => {
    const content = renderCliShim({ node: env.node, entry: env.entry, shimPath: launcher, t3Home: env.t3Home });
    try {
      const existing = (await fs.exists(launcher)) ? await fs.readText(launcher) : null;
      if (existing !== null && !existing.includes(MARKER)) throw new Error("foreign");
      if (existing !== content) {
        await fs.mkdirp(dirname(launcher));
        const staging = `${launcher}.${random()}.tmp`;
        await fs.writeText(staging, content);
        await fs.chmodExecutable(staging);
        await fs.rename(staging, launcher);
      }
    } catch {
      throw fail(`Could not set up the t3 launcher at ${launcher}.`);
    }
    const activator = join(dirname(launcher), "activate.mjs");
    const activatorContent = renderActivationClientScript({ dir: activationDirectoryFor(env.home) });
    await safe(async () => {
      const existing = (await fs.exists(activator)) ? await fs.readText(activator) : null;
      if (existing === activatorContent) return;
      const staging = `${activator}.${random()}.tmp`;
      await fs.writeText(staging, activatorContent);
      await fs.rename(staging, activator);
    }, undefined);
  };

  const install = async (): Promise<CliCommandState> => {
    await ensureLauncher();
    const replaced = await installedAt();
    if (replaced !== null && (await safe(() => fs.readlink(replaced), null)) === launcher) return state();
    const shadowedBy = await foreignFirstOnPath();
    if (shadowedBy !== null && shadowedBy !== replaced) {
      throw fail(`Another t3 at ${shadowedBy} runs first in a new terminal. Remove it, or run the launcher directly at ${launcher}.`);
    }
    const onPath = pathEntries(env.path).map((entry) => entry.replace(/\/+$/, ""));
    const order = new Set([
      ...(replaced === null ? [] : [dirname(replaced)]),
      ...userCandidates.filter((candidate) => onPath.includes(candidate)),
      ...userCandidates.filter((candidate) => !onPath.includes(candidate)),
    ]);
    for (const directory of order) {
      const link = join(directory, "t3");
      const created = await safe(async () => { if (!(await fs.exists(directory))) await fs.mkdirp(directory); return true; }, false);
      if (!created) continue;
      const linked = await safe(async () => {
        if (link === replaced) {
          const staging = `${link}.${random()}.tmp`;
          await fs.symlink(launcher, staging);
          try { await fs.rename(staging, link); } catch (error) { await safe(() => fs.unlink(staging), undefined); throw error; }
        } else {
          await fs.symlink(launcher, link);
        }
        return true;
      }, false);
      if (!linked) continue;
      if (replaced !== null && replaced !== link) await safe(() => fs.unlink(replaced), undefined);
      return state();
    }
    throw fail(`Another t3 command is already in ~/.local/bin and ~/bin, or neither is writable. Run the launcher directly at ${launcher}.`);
  };

  const uninstall = async (): Promise<CliCommandState> => {
    for (const directory of knownLocations) {
      const link = join(directory, "t3");
      if (await isOurLink(link)) {
        try { await fs.unlink(link); } catch { throw fail(`Could not remove ${link}.`); }
      }
    }
    return state();
  };

  const addToPath = async (): Promise<CliCommandState> => {
    const installed = await installedAt();
    if (installed === null || !(await leadsHere(installed))) throw fail("Install the t3 command first.");
    const setup = startupLine(installed);
    if (setup === undefined) throw fail("T3 Code cannot add t3 to this shell's PATH.");
    const shadowedBy = await foreignFirstOnPath();
    if (shadowedBy !== null) throw fail(`Another t3 at ${shadowedBy} runs first; T3 Code leaves it in place.`);
    if (!folderOnPath(installed) && !(await hasLine(setup))) {
      try {
        await fs.mkdirp(dirname(setup.path));
        const previous = (await fs.exists(setup.path)) ? await fs.readText(setup.path) : "";
        await fs.writeText(setup.path, `${previous}\n# Added by T3 Code\n${setup.line}\n`);
      } catch {
        throw fail(`Could not add t3 to ${setup.file}.`);
      }
    }
    return state();
  };

  return { state, install, uninstall, addToPath, launcher };
}

/** CliCommandSettingsRow's description. */
export function cliCommandDescription(state: CliCommandState): string {
  const installed = state.installedPath !== null;
  return state.shadowedBy
    ? `Another t3 at ${state.shadowedBy} runs first in a new terminal. Remove it to use T3 Code's.`
    : !installed
      ? "Run T3 Code's CLI as `t3` from any terminal."
      : state.onPath
        ? `Installed at ${state.installedPath}. Open a new terminal to use it.`
        : state.pathSetup?.added
          ? `Installed at ${state.installedPath} and added to PATH in ${state.pathSetup.file}. Open a new terminal to use it.`
          : `Installed at ${state.installedPath}, which is not on your PATH yet.${state.pathSetup ? "" : " Add its folder to your PATH to run `t3`."}`;
}

export const CLI_FAILURE_TITLES = {
  install: "Could not install t3",
  uninstall: "Could not remove t3",
  addToPath: "Could not add t3 to PATH",
} as const;

export interface FirstLaunchStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export const CLI_FIRST_LAUNCH_KEY = "desktop.cli.firstLaunchDone";

export interface FirstLaunchResult {
  attempted: boolean;
  state?: CliCommandState;
  reason?: string;
}

/** DesktopCliCommand.installOnFirstLaunch, 1:1 in intent (not in the marker's storage, which here is NSH `Storage`
 * rather than a file next to userData): mark first so a failed or removed install is never retried behind the
 * user's back, then only install when nothing on a watched PATH folder already owns (or shadows) `t3`. A run with
 * no launcher-supplied environment (unpackaged dev, same gate as CliCommandSettingsRow) never marks and never
 * installs, so it can run again once the launcher does supply one. */
export async function installCliOnFirstLaunch(env: CliEnvironment | null, storage: FirstLaunchStorage, fs: CliFs = realFs): Promise<FirstLaunchResult> {
  if (env === null) return { attempted: false, reason: "no-cli-environment" };
  if ((await storage.getItem(CLI_FIRST_LAUNCH_KEY)) === "1") return { attempted: false, reason: "already-ran" };
  await storage.setItem(CLI_FIRST_LAUNCH_KEY, "1");
  const cli = createCliCommand(env, fs);
  const before = await cli.state();
  if (before.shadowedBy) return { attempted: true, state: before, reason: "shadowed-by-another-t3" };
  if (before.installedPath !== null) return { attempted: true, state: before, reason: "already-installed" };
  try {
    return { attempted: true, state: await cli.install() };
  } catch (error) {
    return { attempted: true, reason: error instanceof Error ? error.message : "install-failed" };
  }
}

let firstLaunchStarted = false;

/** The app's own call, with the real launcher environment and NSH `Storage`; the app never awaits or throws from
 * this (a failed install is reported through Settings' own row, not here). */
export function startCliFirstLaunch(): void {
  if (firstLaunchStarted) return;
  firstLaunchStarted = true;
  const storage: FirstLaunchStorage = { getItem: (key) => desktop().getItem(key), setItem: (key, value) => desktop().setItem(key, value) };
  void installCliOnFirstLaunch(cliEnvironmentFromProcess(), storage).catch(() => undefined);
}
