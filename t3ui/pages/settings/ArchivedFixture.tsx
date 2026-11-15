import { mount, signal, Text, View } from "nsh";
import { ConfirmDialogHost, ToastHost } from "../../components/toast";
import { SettingsPageContainer } from "../../components/SettingsLayout";
import { ArchivedView } from "./Archived";
import type { BackendStatus } from "../../store";
import type { ArchivedItem } from "./archivedLogic";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const status = signal<BackendStatus>("connected");
const loading = signal(false);
const log = signal<string[]>([]);
const failing = signal(false);
const items = signal<ArchivedItem[]>([
  { id: "t1", projectId: "p1", title: "Fix flaky build", createdAt: NOW - 5 * 86_400_000, updatedAt: NOW - 2 * 86_400_000 },
  { id: "t2", projectId: "p1", title: "Newer archive", createdAt: NOW - 3 * 86_400_000, updatedAt: NOW - 3_600_000 },
  { id: "t3", projectId: "p2", title: "Other project work", createdAt: NOW - 86_400_000, updatedAt: NOW - 600_000 },
]);
const confirm = signal(true);

mount(() => (
  <View class="flex-1">
    <View accessibilityLabel="Disconnect fixture" onPress={() => status.set("disconnected")}><Text>Disconnect fixture</Text></View>
    <View accessibilityLabel="Load fixture" onPress={() => loading.set(true)}><Text>Load fixture</Text></View>
    <View accessibilityLabel="Empty fixture" onPress={() => items.set([])}><Text>Empty fixture</Text></View>
    <View accessibilityLabel="Fail actions" onPress={() => failing.set(true)}><Text>Fail actions</Text></View>
    <View accessibilityLabel="No confirm" onPress={() => confirm.set(false)}><Text>No confirm</Text></View>
    <Each of={log()} key={(entry) => entry}>{(entry) => <Text>{entry()}</Text>}</Each>
    <ConfirmDialogHost />
    <ToastHost />
    <SettingsPageContainer>
      <ArchivedView
        status={status()}
        loading={loading()}
        error={null}
        threads={items()}
        projectName={(id) => (id === "p1" ? "Alpha" : id === "p2" ? "Beta" : null)}
        confirmDelete={confirm()}
        now={NOW}
        onRefresh={() => log.update((l) => [...l, "refreshed"])}
        onRestore={async (id) => {
          if (failing()) throw new Error("server said no");
          items.update((all) => all.filter((t) => t.id !== id));
          log.update((l) => [...l, `restored ${id}`]);
        }}
        onDelete={async (id) => {
          items.update((all) => all.filter((t) => t.id !== id));
          log.update((l) => [...l, `deleted ${id}`]);
        }}
      />
    </SettingsPageContainer>
  </View>
));
