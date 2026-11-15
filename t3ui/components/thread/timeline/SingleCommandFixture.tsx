import { mount, signal, Text, View } from "nsh";
import { WorkGroupRow } from "./TimelineRows";
import type { WorkItem } from "./workLog";

const first: WorkItem = { id: "one", type: "command_execution", title: "Command", detail: "npm test\n\npassed", status: "completed" };
const second: WorkItem = { id: "two", type: "command_execution", title: "Command", detail: "git status", status: "completed" };
const items = signal<WorkItem[]>([first]);
const expanded = signal<Record<string, boolean>>({});
const messageLeft = signal(-1);
const workLeft = signal(-1);
const active = signal(false);
mount(() => <View class="w-full"><View class="mx-auto w-full max-w-[736px]" onLayout={(event) => messageLeft.set(event.bounds.origin.x)}><Text>Message column</Text></View><WorkGroupRow id="work:one" items={items} active={active} expandedActivity={expanded} onLaneLayout={(left) => workLeft.set(left)} onToggle={(id) => expanded.update((current) => ({ ...current, [id]: !current[id] }))} /><View role="button" accessibilityLabel="Add command" onPress={() => items.set([first, second])}><Text>Add command</Text></View><View role="button" accessibilityLabel="Remove command" onPress={() => items.set([first])}><Text>Remove command</Text></View><View role="button" accessibilityLabel="Activate command" onPress={() => active.set(true)}><Text>Activate command</Text></View><Text>{`message-left:${messageLeft()}`}</Text><Text>{`work-left:${workLeft()}`}</Text></View>);
