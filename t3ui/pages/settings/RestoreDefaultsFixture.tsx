import { mount, Text, View } from "nsh";
import { ConfirmDialogHost } from "../../components/toast";
import { Settings } from "../Settings";
import { openSettings, settingValue, updateSetting } from "../../store";

openSettings("/settings/general");
mount(() => (
  <View class="flex-1">
    <View accessibilityLabel="Change time format" onPress={() => updateSetting("timestampFormat", "24-hour")}><Text>Change time format</Text></View>
    <Text>{`time format: ${String(settingValue("timestampFormat"))}`}</Text>
    <Settings />
    <ConfirmDialogHost />
  </View>
));
