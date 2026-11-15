// promptLinks/NewThreadLinkView.tsx LinkPage: the page an incoming `/new` link shows while it needs an answer or a moment: "Opening the
// link...", "Could not open the link", "You don't have owner/name" (Clone / Use without project) and "Check out owner/name#N?".
// `Empty` / `EmptyHeader` / `EmptyTitle` / `EmptyDescription`: a centred column, max-w-md, title text-xl font-semibold,
// description text-sm text-muted-foreground, the buttons `mt-5 flex justify-center gap-2` (ui/button size sm).
import { Text, View } from "nsh";
import { useOverlayOpen } from "../components/rightPanel/nativeOcclusion";
import { sidebarOpen } from "../store";
import { sidebarWidth } from "../components/sidebar/sidebarWidth";
import type { NewThreadLinkController } from "./newThreadLink";
import { linkPageView } from "./newThreadLinkPageView";
import { newThreadLinkController } from "./webLinks";

function LinkButton(props: { label: string; primary?: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      class={`h-7 items-center justify-center rounded-lg px-[9px] active:scale-[0.97] transition-transform duration-150 ease-in-out ${props.primary ? "bg-primary hover:opacity-90" : "border border-input bg-popover hover:bg-accent-50"} ${props.disabled ? "opacity-64" : ""}`}
    >
      <Text class={`text-sm font-medium ${props.primary ? "text-primary-foreground" : "text-foreground"}`}>{props.label}</Text>
    </View>
  );
}

export function NewThreadLinkPage(props: { controller: NewThreadLinkController }) {
  const view = () => linkPageView(props.controller.state(), props.controller.checkingOut(), props.controller);
  useOverlayOpen(() => view() !== null, "new thread link");
  return () => {
    const page = view();
    if (page === null) return null;
    return (
      // The page fills the area beside the sidebar, as SidebarInset does; the sidebar stays usable.
      <View class="absolute bottom-0 right-0 top-0 z-30 items-center justify-center bg-background p-6" style={{ left: sidebarOpen() ? sidebarWidth() : 0 }} desktop={{ windowDrag: true }} accessibilityLabel={page.title}>
        <View class="max-w-md items-center">
          <Text class="text-center text-xl font-semibold text-foreground" role="header">{page.title}</Text>
          {page.description ? <Text class="mt-1 text-center text-sm text-muted-foreground">{page.description}</Text> : null}
          {page.actions.length > 0 ? (
            <View class="mt-5 flex-row justify-center gap-2">
              {page.actions.map((action) => <LinkButton label={action.label} primary={action.primary} disabled={action.disabled} onPress={() => action.run(props.controller)} />)}
            </View>
          ) : null}
        </View>
      </View>
    );
  };
}

/** What the shell mounts: the page of the installed links' controller, nothing before they are installed. */
export function NewThreadLinkHost() {
  return () => (newThreadLinkController() ? <NewThreadLinkPage controller={newThreadLinkController()!} /> : null);
}
