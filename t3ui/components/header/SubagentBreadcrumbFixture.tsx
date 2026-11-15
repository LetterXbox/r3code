import { mount, View } from "nsh";
import { ThreadHeader } from "./ThreadHeader";

mount(() => <View><ThreadHeader thread={() => ({ id: "child", title: "/root/smoke_origin", status: "running", pinned: false, relations: { parentThreadId: "parent", linkOrigin: null, guestShare: null, lineage: { parentThreadId: "parent", relationshipToParent: "subagent", rootThreadId: "parent", sideChat: false } } })} isServer={() => false} parentTitle={() => "Parent"} /></View>);
