// The browser's in-place pages alone: the unreachable page (no description, a numeric code) and the file-not-shown page.
import { mount, signal, Text, View } from "nsh";
import { PreviewFileNotShown, PreviewUnreachable } from "./previewUnreachable";

const opened = signal(0);
function Fixture() {
  return (
    <View class="flex-1 flex-row bg-background">
      <PreviewUnreachable url="http://localhost:3000/x" description="" code="-102" onReload={() => {}} />
      <PreviewFileNotShown url="http://localhost:3000/report.pdf" fileName="report.pdf" onOpen={() => opened.set(opened() + 1)} />
      <Text>{`opened ${opened()}`}</Text>
    </View>
  );
}
mount(Fixture);
