import { mount, View } from "nsh";
import { LocalEnvironmentSetting } from "./LocalEnvironment";
import { ToastHost } from "../../../components/toast/ToastHost";

mount(() => (
  <View class="flex-1">
    <LocalEnvironmentSetting />
    <ToastHost />
  </View>
));
