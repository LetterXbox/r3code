import { mount, signal, View } from "nsh";
import { UsageLimitsBanner } from "./UsageLimitsBanner";
import { parseUsageLimits } from "./usageLimitsLogic";

const now = Date.parse("2026-01-01T00:00:00Z");
const limits = parseUsageLimits({
  checkedAt: "2026-01-01T00:00:00Z",
  windows: [
    { id: "session", kind: "session", label: "5h session", usedPercent: 30, resetsAt: "2026-01-01T02:30:00Z", windowDurationMins: 300 },
    { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 100 },
  ],
  resetCredits: { availableCount: 2 },
})!;
const open = signal(true);
function Fixture() {
  return <View class="w-[600px]">{open() ? <UsageLimitsBanner title="Claude · Max" limits={() => limits} now={() => now} onDismiss={() => open.set(false)} /> : null}</View>;
}
mount(Fixture);
