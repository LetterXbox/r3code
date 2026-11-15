import { mount, View } from "nsh";
import { NativeChildWorkDialog } from "./NativeChildWorkDialog";

const calls: string[] = [];
const request = async (method: string, payload: unknown) => {
  calls.push(`${method}:${(payload as { threadId: string }).threadId}`);
  return { children: [{ conversationId: "c1", role: "Researcher", prompt: "Look around", truncated: true, steps: [
    { index: 0, type: "TOOL_CALL", status: "RUNNING", text: null, toolCalls: [{ name: "grep", input: "foo" }] },
    { index: 1, type: "MESSAGE", status: "DONE", text: "Found it", toolCalls: [] },
  ] }] };
};

mount(() => (
  <View class="flex-1 bg-background p-4">
    <NativeChildWorkDialog threadId={() => "thread-1"} request={request} />
  </View>
));
