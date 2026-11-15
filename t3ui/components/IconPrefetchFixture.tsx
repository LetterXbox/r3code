// Fixture: prefetches every icon and reports when the prefetch settles.
import { mount, signal, Text, View } from "nsh";
import { ICON_COUNT, Icon, prefetchIcons } from "./Icons";
import { HEADER_ICONS } from "./header/HeaderIcons";

const status = signal("pending");
void prefetchIcons(HEADER_ICONS).then(() => status.set(`prefetched ${ICON_COUNT}`));

function Fixture() {
  return (
    <View>
      <Text>{status()}</Text>
      <Icon name="archive" />
    </View>
  );
}

mount(Fixture);
