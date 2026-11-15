import { mount, Text, View } from "nsh";
import { ExpandedMediaHost, expandMedia } from "./ExpandedMedia";

function Fixture() {
  return (
    <View class="flex-1">
      <View accessibilityLabel="Open image" role="button" onPress={() => expandMedia({ items: [{ name: "shot.png", kind: "image", source: { kind: "url", url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" } }], index: 0 })}><Text>Open image</Text></View>
      <ExpandedMediaHost />
    </View>
  );
}

mount(Fixture);
