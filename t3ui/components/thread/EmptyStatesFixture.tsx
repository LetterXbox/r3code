import { mount, signal, Text, View } from "nsh";
import { NoActiveThreadState, NoProjectsHero } from "./EmptyStates";

const showHero = signal(true);

function Fixture() {
  return (
    <View class="flex-1">
      <View accessibilityLabel="Toggle state" onPress={() => showHero.update((value) => !value)}><Text>toggle</Text></View>
      {showHero() ? <NoProjectsHero /> : <NoActiveThreadState />}
    </View>
  );
}

mount(Fixture);
