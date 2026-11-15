import { mount, signal, Text, View } from "nsh";
import { observeServerConfigEvent } from "./settingsState";
import { UpdateTrackSwitchDialog } from "./UpdateTrackSwitchDialog";

// The dialog asks the server only when its config says registry lookups are supported.
observeServerConfigEvent({ type: "snapshot", config: { settings: {}, keybindings: [], environment: { capabilities: { npmReleaseLookup: true } } } });

const calls = signal<string[]>([]);
mount(() => (
  <View class="flex-1">
    <Each of={calls()} key={(call, index) => `${index}${call}`}>{(call) => <Text>{`call ${call()}`}</Text>}</Each>
    <UpdateTrackSwitchDialog
      channel="nightly"
      appVersion="1.2.3"
      updater={null}
      onClose={() => undefined}
      request={(method, payload) => { calls.update((items) => [...items, `${method} ${JSON.stringify(payload)}`]); return Promise.resolve({ version: "1.3.0-nightly.1", databaseMigration: 5 }); }}
    />
  </View>
));
