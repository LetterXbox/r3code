import { mount, Scroll, Text, View } from "nsh";
import { ConfirmDialogHost, ToastHost } from "../../components/toast";
import { ConnectionSettings } from "./Connection";
import { savedEnvironments } from "./environments/savedEnvironments";

savedEnvironments.set([{ id: "saved:box", label: "Box", url: "wss://box.example.com/ws", enabled: false, addedAt: 0, alternateUrls: ["ws://192.168.1.4:3773/ws"] }]);
mount(() => (
  <View class="flex-1">
    <Text>{`preferred ${savedEnvironments()[0]?.url ?? ""} · ${(savedEnvironments()[0]?.alternateUrls ?? []).length + 1} routes`}</Text>
    <Scroll class="flex-1"><View class="gap-4 p-4"><ConnectionSettings /></View></Scroll>
    <ConfirmDialogHost />
    <ToastHost />
  </View>
));
