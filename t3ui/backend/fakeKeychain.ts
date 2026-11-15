// A fake macOS `security` CLI for tests: generic passwords in a Map, the exit codes and the line limit of the real one
// (`security -i` cannot take a line past about 4 KiB: the rest runs as another, unknown command). Tests only.
import { createKeychainStorage, type SecureStorage, type SecurityCli, type SecurityCliResult } from "./secureStorage";

export interface FakeKeychain {
  cli: SecurityCli;
  storage: SecureStorage;
  /** "<service>\u0000<account>" -> password. */
  items: Map<string, string>;
  /** Every argv the CLI was run with (interactive command lines are not here: they never reach argv). */
  argvLog: string[][];
  /** Every interactive line fed to stdin. */
  stdinLog: string[];
  unavailable: boolean;
  /** Makes the next interactive command fail as the real CLI does. */
  failNextWrite: boolean;
}

const result = (code: number, stdout = "", stderr = ""): SecurityCliResult => ({ code, stdout, stderr });
const LINE_LIMIT = 4096;

function flag(args: string[], name: string): string | null {
  const at = args.indexOf(name);
  return at >= 0 && at + 1 < args.length ? args[at + 1]! : null;
}

function words(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? "");
}

export function createFakeKeychain(service = "test-service"): FakeKeychain {
  const fake: FakeKeychain = {
    items: new Map(), argvLog: [], stdinLog: [], unavailable: false, failNextWrite: false,
    cli: null as unknown as SecurityCli, storage: null as unknown as SecureStorage,
  };
  const key = (svc: string | null, account: string | null) => `${svc}\u0000${account}`;
  fake.cli = {
    async available() { return !fake.unavailable; },
    async run(args) {
      fake.argvLog.push(args);
      if (args[0] === "find-generic-password") {
        const value = fake.items.get(key(flag(args, "-s"), flag(args, "-a")));
        return value === undefined ? result(44, "", "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.") : result(0, `${value}\n`);
      }
      if (args[0] === "delete-generic-password") {
        return fake.items.delete(key(flag(args, "-s"), flag(args, "-a"))) ? result(0, "password has been deleted.\n") : result(44, "", "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.");
      }
      return result(1, "", "security: unknown command");
    },
    async runInteractive(line) {
      fake.stdinLog.push(line);
      if (fake.failNextWrite) { fake.failNextWrite = false; return result(0, "add-generic-password: returned 2\n"); }
      // The real CLI splits an over-long line: the head runs as a command, the rest as an unknown one.
      const first = line.slice(0, LINE_LIMIT);
      const parts = words(first);
      if (line.length > LINE_LIMIT || parts[0] !== "add-generic-password") return result(0, `security: unknown command "${line.slice(LINE_LIMIT, LINE_LIMIT + 8)}"\nadd-generic-password: returned 2\n`);
      fake.items.set(key(flag(parts, "-s"), flag(parts, "-a")), flag(parts, "-w") ?? "");
      return result(0);
    },
  };
  fake.storage = createKeychainStorage({ cli: fake.cli, service });
  return fake;
}
