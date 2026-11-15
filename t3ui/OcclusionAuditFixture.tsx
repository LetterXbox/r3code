// The full shell as App.tsx composes it, plus a readout of the occlusion registry, so a test can prove it is empty at rest.
import { keymap, mount, Text, View } from "nsh";
import { installKeybindings } from "./commands/registry";
import { installStandardCommands, toggleSettings } from "./commands/standardCommands";
import { CommandPalette } from "./components/CommandPalette";
import { Sidebar } from "./components/Sidebar";
import { SidebarAddProject } from "./components/SidebarAddProject";
import { openOverlayLabels } from "./components/rightPanel/nativeOcclusion";
import { ShellOverlays } from "./shell/ShellOverlays";
import { RootErrorBoundary } from "./shell/RootErrorView";
import { Settings } from "./pages/Settings";
import { PullRequests } from "./pages/PullRequests";
import { Usage } from "./pages/Usage";
import { ThreadView } from "./pages/ThreadView";
import { settingsOpen, sidebarOpen, utilityPage } from "./store";

installStandardCommands();
installKeybindings();
keymap.bind({ "mod+,": toggleSettings });

mount(() => (
  <View class="relative flex-1 flex-row bg-background">
    <Text>{`overlays:[${openOverlayLabels().join(",")}]`}</Text>
    <RootErrorBoundary>
      {sidebarOpen() ? <Sidebar /> : null}
      {utilityPage() !== null ? <PullRequests /> : <ThreadView />}
      {settingsOpen() ? <Settings /> : null}
      <Usage />
      <CommandPalette />
      <SidebarAddProject />
    </RootErrorBoundary>
    <ShellOverlays />
  </View>
));
