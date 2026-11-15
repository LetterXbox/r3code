import { mount, View } from "nsh";
import { WorkingRow } from "./TimelineRows";

function Fixture() {
  return (
    <View>
      <WorkingRow since={() => Date.now() - 4_000} compacting={() => true} />
      <WorkingRow since={() => Date.now() - 2_000} preparing={() => true} />
      <WorkingRow since={() => null} />
    </View>
  );
}

mount(Fixture);
