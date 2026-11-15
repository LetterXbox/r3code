import { mount, signal, Text, View } from "nsh";
import { ToastHost } from "../../components/toast";
import { setFontEnumerationForTest } from "../../desktop/fonts";
import { FontFamilyPicker } from "./FontFamilyPicker";

setFontEnumerationForTest({ status: "granted", families: ["Fira Code", "Helvetica", "Menlo"], monospace: new Set(["Fira Code", "Menlo"]) });
const code = signal("");
mount(() => (
  <View class="flex-1 gap-3 p-4">
    <FontFamilyPicker ariaLabel="Code font family" defaultFamily="System monospace" selectedFamily={code()} requireMonospace onSelect={(family) => code.set(family)} />
    <Text>{`code=${code()}`}</Text>
    <ToastHost />
  </View>
));
