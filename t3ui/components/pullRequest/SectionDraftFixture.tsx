import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { Section } from "./PullRequestSummaryTab";

function Draft() {
  const value = signal("");
  return <View><Input accessibilityLabel="Description draft" value={value()} onChange={(event) => value.set(event.value)} /><Text>{`Draft: ${value()}`}</Text></View>;
}

mount(() => <View class="flex-1"><Section title="Description" keepMounted><Draft /></Section></View>);
