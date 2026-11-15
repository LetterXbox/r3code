import { provider, seedServer } from "./FirstRunSeed";

seedServer({
  fresh: true,
  providers: [
    provider("claudeAgent", "claudeAgent", "Claude"),
    provider("codex", "codex", "Codex", { auth: { status: "unauthenticated" } }),
    provider("opencode", "opencode", "OpenCode", { enabled: false, status: "disabled" }),
  ],
});
