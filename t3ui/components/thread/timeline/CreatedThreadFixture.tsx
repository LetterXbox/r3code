import { mount, signal, Text, View } from "nsh";
import { AttemptFoldRow, CreatedThreadRow } from "./TimelineRows";

function CreatedThreadFixture() {
  const opened = signal("");
  const expanded = signal(false);
  return (
    <View class="gap-2 p-4">
      <CreatedThreadRow title={() => "Fix the build"} resourceSummary={() => false} onOpen={() => opened.set("log")} />
      <CreatedThreadRow title={() => null} resourceSummary={() => true} onOpen={() => opened.set("card")} />
      <AttemptFoldRow label={() => "Superseded attempt"} expanded={expanded} onToggle={() => expanded.set(!expanded())} />
      <Text testID="opened">{opened() || "none"}</Text>
      <Text testID="expanded">{expanded() ? "open" : "closed"}</Text>
    </View>
  );
}

mount(CreatedThreadFixture);
