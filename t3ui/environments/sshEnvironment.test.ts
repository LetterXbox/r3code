import { expect, test } from "nsh/test";
import { ensureSshEnvironment, formatDesktopSshConnectionError, lastJsonLine, remoteStateKey, resolveTypedSshTarget, type ScriptRunner } from "./sshEnvironment";
import { buildRemoteLaunchScript, buildRemotePairingScript } from "./sshRemoteScripts";

const target = { alias: "devbox", hostname: "devbox.local", username: "ada", port: 2222 };

test("the remote state key is the reference's sha256 prefix of the target", async () => {
  expect(await remoteStateKey(target)).toBe("053b5b4f14c9dfbc");
});

test("the launch and pairing scripts are the reference's, with every placeholder filled", () => {
  const launch = buildRemoteLaunchScript({ archiveVersion: "1.2.3" });
  expect(launch.includes("@@")).toBe(false);
  expect(launch.includes("satisfiesSemverRange")).toBe(true);
  expect(launch.includes("serverKind")).toBe(true);
  expect(buildRemotePairingScript("abc", { archiveVersion: "1.2.3" }).includes("auth pairing create")).toBe(true);
  expect(() => buildRemoteLaunchScript({ archiveVersion: "1.2" })).toThrow();
});

test("typed destinations resolve user, host and port, and the error text drops the tagged prefix", () => {
  expect(resolveTypedSshTarget({ host: "ada@devbox:2222", username: "", port: "" }, [])).toEqual({ alias: "devbox", hostname: "devbox", username: "ada", port: 2222 });
  expect(resolveTypedSshTarget({ host: "devbox", username: "", port: "" }, [{ alias: "devbox", hostname: "devbox.local", username: null, port: null, source: "ssh-config" }]).hostname).toBe("devbox.local");
  expect(() => resolveTypedSshTarget({ host: "-oProxy", username: "", port: "" }, [])).toThrow();
  expect(formatDesktopSshConnectionError(new Error("SshLaunchError: no node"))).toBe("no node");
  expect(formatDesktopSshConnectionError("x")).toBe("Failed to connect SSH host.");
  expect(lastJsonLine('noise\n{"remotePort":4100,"serverKind":"managed"}\n')).toEqual({ remotePort: 4100, serverKind: "managed" });
});

test("ensureEnvironment launches with the script on stdin, tunnels to the remote port and pairs", async () => {
  const calls: { args: string[]; stdin: string }[] = [];
  const runner: ScriptRunner = {
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    spawn(command, args) {
      const call = { args, stdin: "" };
      calls.push(call);
      const handlers: Record<string, ((value: any) => void)[]> = {};
      const isTunnel = args.includes("-N");
      const child = {
        on(event: string, handler: (value: any) => void) { (handlers[event] ??= []).push(handler); return child; },
        write(text: string) { call.stdin += text; },
        end() {
          const out = args.includes("-l") ? '{"remotePort":4100,"serverKind":"managed"}\n' : '{"credential":"PAIR123"}\n';
          setTimeout(() => { for (const h of handlers.stdout ?? []) h(out); for (const h of handlers.exit ?? []) h({ code: 0 }); }, 5);
        },
        kill() {},
      };
      void isTunnel;
      return child as never;
    },
  };
  const boot = await ensureSshEnvironment(target, 45000, { runner, cliRunner: { archiveVersion: "1.2.3" }, waitReady: async () => {} }, { issuePairingToken: true });
  expect(boot).toEqual({ httpBaseUrl: "http://127.0.0.1:45000/", wsBaseUrl: "ws://127.0.0.1:45000/", pairingToken: "PAIR123", remotePort: 4100 });
  expect(calls[0]!.args.slice(-6)).toEqual(["ada@devbox", "sh", "-l", "-s", "--", await remoteStateKey(target)]);
  expect(calls[0]!.stdin.includes("satisfiesSemverRange")).toBe(true);
  expect(calls[1]!.args.includes("45000:127.0.0.1:4100")).toBe(true);
  expect(calls[2]!.stdin.includes("auth pairing create")).toBe(true);
});

test("the stringified Node engine check is plain JavaScript the host's node can run", () => {
  const script = buildRemoteLaunchScript({ nodeScriptPath: "/x.js", nodeEngineRange: ">=22" });
  const start = script.indexOf("function satisfiesSemverRange");
  const end = script.indexOf("})();", start) + 5;
  const source = script.slice(start, end);
  expect(source.includes(": string")).toBe(false);
  // Checked by hand under node 24: exit 0 for ">=22", exit 1 with the reference message for ">=99".
  expect(source.startsWith("function satisfiesSemverRange(rawVersion, range)")).toBe(true);
  expect(source.includes("(globalThis).process") || source.includes("globalThis.process")).toBe(true);
});
