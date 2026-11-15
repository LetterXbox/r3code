// sidebar/SidebarThreadUndoNotice.tsx: fills the free space in the footer utility row with
// "<Action>, Undo" after a settle, snooze, unpin or archive. text-2xs, muted.
import { Text, View } from "nsh";
import { threadUndo } from "./threadActions";

export function SidebarThreadUndoNotice() {
  return (
    <>
      {threadUndo.notice() ? (
        <View class="min-w-0 flex-1 flex-row items-center justify-end gap-1">
          <Text class="text-2xs text-sidebar-muted-foreground">{threadUndo.summary(threadUndo.notice()!)},</Text>
          <View
            role="button"
            accessibilityLabel="Undo thread action"
            onPress={() => { void threadUndo.run(); }}
            class="h-6 items-center justify-center rounded px-1 hover:bg-sidebar-row-hover"
          >
            <Text class="text-2xs text-sidebar-foreground">{threadUndo.label()}</Text>
          </View>
        </View>
      ) : null}
    </>
  );
}
