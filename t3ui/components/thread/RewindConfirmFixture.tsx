import { mount, signal, Text, View } from "nsh";
import { RewindConfirm } from "./RewindConfirm";

const result = signal("");
const open = signal(true);

function Fixture() {
  return (
    <View>
      {open() ? <RewindConfirm onCancel={() => { result.set("cancelled"); open.set(false); }} onConfirm={(restoreFiles) => { result.set(restoreFiles ? "files" : "keep"); open.set(false); }} /> : null}
      <Text>{`Result ${result()}`}</Text>
    </View>
  );
}

mount(Fixture);
