import { mount, signal, Text, View } from "nsh";
import { createThread } from "../../store";
import { setPermissionsOpen } from "../composer/composerControls";
import { ModeControls, PickerFooter, type InteractionChoice, type RuntimeChoice } from "./ModeControls";

createThread(null);
const runtime = signal<RuntimeChoice>("approval-required");
const interaction = signal<InteractionChoice>("default");
function Fixture() {
  return <View>
    <View accessibilityLabel="composer.mode" onPress={() => setPermissionsOpen("chip", true)}><Text>composer.mode</Text></View>
    <ModeControls
      disabled={() => false}
      runtime={runtime}
      availableRuntime={() => ["approval-required", "full-access"]}
      defaultRuntime={() => "full-access"}
      onRuntime={async (mode) => runtime.set(mode)}
    />
    <PickerFooter
      disabled={() => false}
      runtime={runtime}
      availableRuntime={() => ["approval-required", "full-access"]}
      interaction={interaction}
      availableInteraction={() => ["default", "plan"]}
      onRuntime={(mode) => runtime.set(mode)}
      onInteraction={(mode) => interaction.set(mode)}
    />
  </View>;
}
mount(Fixture);
