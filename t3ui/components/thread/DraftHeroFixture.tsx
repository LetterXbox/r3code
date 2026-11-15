import { mount, signal, Text, View } from "nsh";
import { DraftHeroHeadline } from "./DraftHero";

const projects = signal([{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }, { id: "s", name: "Scratch" }]);
const current = signal<string | undefined>("a");
const added = signal(false);
const width = signal(1000);

function Fixture() {
  return (
    <View style={{ width: width() }}>
      <DraftHeroHeadline projectId={current} projects={projects} onPickProject={(id) => current.set(id)} onAddProject={() => added.set(true)} />
      {added() ? <Text>Add project opened</Text> : null}
      <View accessibilityLabel="No projects" onPress={() => { projects.set([]); current.set(undefined); }}><Text>No projects</Text></View>
      <View accessibilityLabel="Use scratch" onPress={() => current.set("s")}><Text>Use scratch</Text></View>
      <View accessibilityLabel="Narrow" onPress={() => width.set(400)}><Text>Narrow</Text></View>
    </View>
  );
}

mount(Fixture);
