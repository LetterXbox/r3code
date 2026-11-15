import { mount, signal, Text, View } from "nsh";
import { observeServerConfigEvent } from "./settingsState";
import { UpdateTrackSwitchDialog } from "./UpdateTrackSwitchDialog";

const calls = signal<string[]>([]);
// An older server: it connects but does not advertise registry lookups.
observeServerConfigEvent({ type: "snapshot", config: { settings: {}, keybindings: [], environment: { capabilities: {} } } });
mount(() => (
  <View class="flex-1">
    <Each of={calls()} key={(call, index) => `${index}${call}`}>{(call) => <Text>{`call ${call()}`}</Text>}</Each>
    <UpdateTrackSwitchDialog channel="nightly" appVersion="1.2.3" updater={null} onClose={() => undefined}
      request={(method) => { calls.update((items) => [...items, method]); return Promise.resolve(null); }} />
  </View>
));
