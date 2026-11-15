import { mount, signal, Text, View } from "nsh";
import { MessageRow } from "./MessageRow";
import type { Message } from "../../store";

const groupedHeight = signal(0);
const singleHeight = signal(0);
const message: Message = { id: "message", role: "user", body: "A short message", order: 1 };

function Fixture() {
  return <View class="w-full">
    <View onLayout={(event) => groupedHeight.set(event.bounds.size.height)}>
      <MessageRow message={() => message} grouping={() => ({ groupedWithNext: true, groupedWithPrevious: false, continuesSteer: false })} />
    </View>
    <View onLayout={(event) => singleHeight.set(event.bounds.size.height)}>
      <MessageRow message={() => message} />
    </View>
    <Text>{`grouped ${groupedHeight()}`}</Text>
    <Text>{`single ${singleHeight()}`}</Text>
  </View>;
}

mount(Fixture);
