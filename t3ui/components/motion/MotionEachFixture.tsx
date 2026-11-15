import { mount, signal, Text, View } from "nsh";
import { MotionEach } from "./Motion";

const rows = signal(["a", "b", "c"]);

mount(() => (
  <View class="p-2">
    <Text onPress={() => rows.set(["a", "c"])}>Remove b</Text>
    <MotionEach of={rows} key={(row) => row}>
      {(row) => <Text>{`row ${row()}`}</Text>}
    </MotionEach>
  </View>
));
