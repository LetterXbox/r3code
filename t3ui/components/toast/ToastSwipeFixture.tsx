// The toast stack with one toast, for the swipe-to-dismiss check.
import { mount, Text, View } from "nsh";
import { ToastHost } from "./ToastHost";
import { showToast, visibleToasts } from "./toastState";

function ToastSwipeFixture() {
  return (
    <View class="h-full w-full">
      <Text>{`toasts=${visibleToasts().length}`}</Text>
      <View role="button" accessibilityLabel="Raise" onPress={() => showToast({ type: "info", title: "Saved", timeoutMs: 0 })}><Text>Raise</Text></View>
      <ToastHost />
    </View>
  );
}
mount(ToastSwipeFixture);
