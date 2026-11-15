import { mount, View } from "nsh";
import { Spinner } from "./Spinner";

mount(() => (
  <View class="w-[200px] bg-sidebar p-2">
    <Spinner size={14} />
  </View>
));
