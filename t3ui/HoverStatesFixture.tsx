// Hover reveals that stand in for the web's `group-hover/settings-row:` (SettingsRow passes its hover to a function
// `inheritance`), checked headless through the createHover state.
import { mount, Text, View } from "nsh";
import { SettingsRow } from "./components/SettingsLayout";

mount(() => (
  <View class="flex-1 p-8">
    <View testID="row">
      <SettingsRow
        title="Model"
        description="The model new threads start with."
        inheritance={(rowHovered: () => boolean) => <Text>{rowHovered() ? "mark revealed" : "mark hidden"}</Text>}
      />
    </View>
    <View testID="elsewhere" class="mt-40 h-10"><Text>Elsewhere</Text></View>
  </View>
));
