import { mount, View } from "nsh";
import { McpAppFrame } from "./McpAppFrame";

const app = { attachmentId: "att-1", server: "weather", tool: "forecast", resourceUri: "ui://weather/app.html" };
const broken = { ...app, attachmentId: "att-2", server: "maps" };
mount(() => (
  <View class="flex-1 gap-2">
    <McpAppFrame app={() => app} threadId={() => "t1"} itemId={() => "i1"} toolCall={() => ({ arguments: {}, result: undefined })} inline={() => false} endpoint="http://127.0.0.1:9/ws" request={async () => ({ relativeUrl: "/api/assets/att-1?sig=x" })} />
    <McpAppFrame app={() => broken} threadId={() => "t1"} itemId={() => "i2"} toolCall={() => ({ arguments: {}, result: undefined })} inline={() => false} endpoint="http://127.0.0.1:9/ws" request={async () => { throw new Error("gone"); }} />
  </View>
));
