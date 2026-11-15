import { mount, signal, Text, View } from "nsh";
import { EnvironmentSelector } from "./EnvironmentSelector";
import { buildEnvironmentOptions } from "./environmentOptions";
import { requestHostMenu, hostMenuRequests } from "../composer/composerControls";

const picked = signal("none");
const autoLabel = signal<string | undefined>(undefined);
const offerAuto = signal(false);
const options = () => buildEnvironmentOptions({
  connected: { id: "env-p", label: "Laptop" }, currentUrl: "ws://127.0.0.1:3773/ws",
  saved: [{ id: "env-a", label: "Studio", url: "wss://studio.example.com/ws", enabled: true }],
});

function Fixture() {
  return (
    <View class="w-[500px] pt-40">
      <EnvironmentSelector options={options} activeId={() => "env-p"} locked={() => false} disabled={() => false} openRequests={hostMenuRequests} onSelect={(option) => { autoLabel.set(undefined); picked.set(option.label); }}
        autoLabel={() => autoLabel()} onAuto={() => (offerAuto() ? () => { autoLabel.set("Checking machines…"); picked.set("auto"); } : undefined)} />
      <Text>{`picked:${picked()}`}</Text>
      <View accessibilityLabel="Offer auto" onPress={() => offerAuto.set(true)}><Text>offer auto</Text></View>
      <View accessibilityLabel="Balanced" onPress={() => autoLabel.set("Auto balance")}><Text>balanced</Text></View>
      <View accessibilityLabel="Host shortcut" onPress={requestHostMenu}><Text>host</Text></View>
    </View>
  );
}
mount(Fixture);
