import { mount, Text, View } from "nsh";
import type { Message } from "../../store";
import { MessageRow } from "./MessageRow";
import { ChatMarkdown } from "./markdown/ChatMarkdown";
import { threadFindActive, threadFindOpen, threadFindQuery } from "./threadFindState";

const long = Array.from({ length: 14 }, (_, index) => `Line ${index + 1} of the prompt`).join("\n") + "\nthe needle is at the end";
const first: Message = { id: "u1", role: "user", body: long };
const second: Message = { id: "u2", role: "user", body: long.replace("needle", "other") };
const details = "<details>\n<summary>More</summary>\n\nhidden needle here\n\n</details>";

function Fixture() {
  return (
    <View>
      <MessageRow message={() => first} />
      <MessageRow message={() => second} />
      <ChatMarkdown text={() => details} findRowId={() => "message:a1"} />
      <ChatMarkdown text={() => "Plain words.\n\n```ts\nconst x = 1 // a very long line before the codeneedle at its end\n```"} findRowId={() => "message:c1"} />
      <View accessibilityLabel="Find in code" role="button" onPress={() => { threadFindOpen.set(true); threadFindQuery.set("codeneedle"); threadFindActive.set({ rowId: "message:c1", occurrence: 0 }); }}><Text>c1</Text></View>
      <View accessibilityLabel="Find needle in u1" role="button" onPress={() => { threadFindOpen.set(true); threadFindQuery.set("needle"); threadFindActive.set({ rowId: "message:u1", occurrence: 0 }); }}><Text>u1</Text></View>
      <View accessibilityLabel="Find needle in a1" role="button" onPress={() => { threadFindOpen.set(true); threadFindQuery.set("needle"); threadFindActive.set({ rowId: "message:a1", occurrence: 0 }); }}><Text>a1</Text></View>
    </View>
  );
}

mount(Fixture);
