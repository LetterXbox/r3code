import { mount, Text, View } from "nsh";
import { openThemeEditorSession, ThemeEditorHost } from "./ThemeEditor";

openThemeEditorSession({ editingThemeId: null, seedTheme: null, seedName: null, initialAppearance: "dark" });
mount(() => <View class="flex-1"><Text>Theme editor fixture</Text><ThemeEditorHost /></View>);
