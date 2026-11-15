import { provider, seedServer } from "./FirstRunSeed";

seedServer({
  fresh: true,
  providers: [
    provider("claudeAgent", "claudeAgent", "Claude", { installed: false, status: "error", auth: { status: "unknown" } }),
    provider("codex", "codex", "Codex", { installed: false, status: "error", auth: { status: "unknown" } }),
    provider("opencode", "opencode", "OpenCode", { enabled: false, status: "disabled" }),
  ],
});
