// The app, plus a line per command id the shell owns saying whether a handler is registered for it.
import "./App";
import { mount, Text, View } from "nsh";
import { hasCommandHandler } from "./commands/registry";

export const SHELL_COMMANDS = [
  "sidebar.toggle", "commandPalette.toggle", "filePicker.toggle", "projectSearch.toggle", "usage.open", "theme.select", "appearance.cycle",
  "themeEditor.toggle", "chat.new", "chat.newLocal", "chat.newWithoutProject", "chat.find", "thread.copyReference", "thread.settle", "thread.undo",
  "preview.toggle", "editor.openFavorite", "view.reopenClosed",
];

mount(() => (
  <View class="flex-1">
    {SHELL_COMMANDS.map((id) => <Text>{`${id}: ${hasCommandHandler(id) ? "yes" : "no"}`}</Text>)}
  </View>
));
