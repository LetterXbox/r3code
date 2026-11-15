import { provider, seedServer } from "./FirstRunSeed";

// A workspace that already has work: the app opens, no Welcome page.
seedServer({ fresh: false, providers: [provider("claudeAgent", "claudeAgent", "Claude")] });
