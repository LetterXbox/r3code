import { mount, Text, View } from "nsh";
import { installThreadSelectionEscape } from "./windowBehaviours";
import { selectedThreadIds, toggleThreadSelection } from "../components/sidebar/threadSelection";

installThreadSelectionEscape();

mount(() => (
  <View>
    <View role="button" accessibilityLabel="Select one" onPress={() => toggleThreadSelection("one")}><Text>Select one</Text></View>
    <View role="button" accessibilityLabel="Select two" onPress={() => toggleThreadSelection("two")}><Text>Select two</Text></View>
    <Text>{`selected ${selectedThreadIds().join(",") || "none"}`}</Text>
  </View>
));
