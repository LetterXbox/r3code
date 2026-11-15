// A long branch in a narrow box and a short one in a wide box.
import { mount, View } from "nsh";
import { MiddleTruncate } from "./MiddleTruncate";

mount(() => (
  <View class="gap-2">
    <View style={{ width: 80 }}><MiddleTruncate value="t3/clone-repo-to-other-machine" /></View>
    <View style={{ width: 300 }}><MiddleTruncate value="feature/b" /></View>
  </View>
));
