// The Environments settings page on its own with the app's toast and confirmation hosts: what the full app shows after
// mod+, and Environments, without bundling, compiling and evaluating the whole ~9.8 MB app for every test.
import { mount, View } from "nsh";
import { SettingsPanel } from "./Panel";
import { ConfirmDialogHost, ToastHost } from "../../components/toast";

mount(() => <View class="flex-1"><SettingsPanel path="/settings/connections" /><ToastHost /><ConfirmDialogHost /></View>);
