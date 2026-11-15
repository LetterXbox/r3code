import { mount, signal, Text, View } from "nsh";
import { PullRequestStackPopover } from "./PullRequestStackPopover";

const opened = signal(0);
let answers = 0;
async function rpc(method: string) {
  if (method !== "pullRequests.stack") throw new Error(method);
  answers++;
  if (answers === 1) return null;
  return { id: "s", number: 4, url: "", base: "main", layers: [{ number: 7, title: "Bottom", headBranch: "a", state: "open", isDraft: false, headSha: "1" }, { number: 8, title: "Top", headBranch: "b", state: "open", isDraft: false, headSha: "2" }] };
}
mount(() => <View class="flex-1 p-4">
  <PullRequestStackPopover reference={{ projectId: "p", repository: "o/r", number: 7 }} membership={{ number: 4, position: 1, size: 2 }} request={rpc} onSelect={(number) => opened.set(number)} />
  <Text>{`opened: ${opened()}`}</Text>
</View>);
