import { mount, View } from "nsh";
import { SnapShotAttachmentDetails } from "./SnapShotDetails";

function Fixture() {
  return (
    <View class="w-[400px] gap-3 p-3">
      <View class="relative h-28 w-52 overflow-hidden rounded-lg border border-border"><SnapShotAttachmentDetails source={{ appName: "Notes", windowTitle: "Shopping list", accessibleText: "Window: Shopping list\n  Button: Add" }} /></View>
      <View class="relative h-28 w-52 overflow-hidden rounded-lg border border-border"><SnapShotAttachmentDetails source={{ appName: "Mail", windowTitle: "" }} /></View>
    </View>
  );
}
mount(Fixture);
