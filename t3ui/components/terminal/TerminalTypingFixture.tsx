// terminalTyping: keys the app receives while the drawer wants the keyboard are written to the terminal sink.
import { effect, mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { bindTerminalTyping, drawerTypingWanted, setTerminalTypeSink } from "./terminalTyping";

function TerminalTypingFixture() {
  const written = signal("");
  setTerminalTypeSink((data) => written.update((all) => all + JSON.stringify(data).slice(1, -1)));
  effect(() => { if (!drawerTypingWanted()) return; return bindTerminalTyping(); });
  return (
    <View>
      <Text>{`pty=[${written()}]`}</Text>
      <View role="button" accessibilityLabel="Want" onPress={() => drawerTypingWanted.set(true)}><Text>Want</Text></View>
      <View role="button" accessibilityLabel="Release" onPress={() => drawerTypingWanted.set(false)}><Text>Release</Text></View>
      <Input accessibilityLabel="Field" value="" />
    </View>
  );
}
mount(TerminalTypingFixture);
