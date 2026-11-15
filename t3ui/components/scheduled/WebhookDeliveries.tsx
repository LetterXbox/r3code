// WebhookDeliveriesDialog (ScheduledTasksSettings.tsx): the recent requests to a webhook task's URL, each with its
// outcome, and one delivery's headers, query, body and the prompt that was sent to the agent.
import { signal, Text, View } from "nsh";
import { SettingsDialog } from "../SettingsDialog";
import { SettingsButton } from "../SettingsLayout";
import { record } from "../../backend/client";
import type { ScheduledTask } from "./data";

export interface DeliverySummary { id: string; receivedAt: string; method: string; outcome: string; pendingWindow: boolean; signatureVerified: boolean; missingFields: string[]; error: string | null }
export interface DeliveryDetail extends DeliverySummary { query: string; headers: Record<string, string>; body: string; bodyTruncated: boolean; renderedPrompt: string | null }

/** webhookDeliveryLabel (scheduledTasksSettings.logic.ts). */
export function deliveryLabel(delivery: Pick<DeliverySummary, "outcome" | "pendingWindow">): string {
  if (delivery.outcome === "accepted") return delivery.pendingWindow ? "Opened window" : "Ran";
  const labels: Record<string, string> = {
    dispatch_failed: "Run failed", duplicate: "Duplicate", coalesced: "Coalesced", filtered: "Filtered", rejected_signature: "Bad signature",
    disabled: "Task paused", rate_limited: "Rate limited", expired: "Too old",
  };
  return labels[delivery.outcome] ?? delivery.outcome.replaceAll("_", " ");
}

function summary(value: unknown): DeliverySummary | null {
  const item = record(value);
  if (!item || typeof item.id !== "string" || typeof item.receivedAt !== "string" || typeof item.method !== "string") return null;
  return {
    id: item.id, receivedAt: item.receivedAt, method: item.method, outcome: typeof item.outcome === "string" ? item.outcome : "unknown", pendingWindow: item.pendingWindow === true,
    signatureVerified: item.signatureVerified === true, missingFields: Array.isArray(item.missingFields) ? item.missingFields.filter((field): field is string => typeof field === "string") : [], error: typeof item.error === "string" ? item.error : null,
  };
}

export function readDeliveries(value: unknown): DeliverySummary[] {
  const list = record(value)?.deliveries;
  return Array.isArray(list) ? list.flatMap((entry) => { const item = summary(entry); return item ? [item] : []; }) : [];
}

export function readDelivery(value: unknown): DeliveryDetail | null {
  const raw = record(record(value)?.delivery);
  const base = summary(raw);
  if (!raw || !base) return null;
  const headers = record(raw.headers) ?? {};
  return {
    ...base, query: typeof raw.query === "string" ? raw.query : "", body: typeof raw.body === "string" ? raw.body : "", bodyTruncated: raw.bodyTruncated === true,
    renderedPrompt: typeof raw.renderedPrompt === "string" ? raw.renderedPrompt : null, headers: Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
  };
}

function Block(props: { title: string; children: string }) {
  return <View class="gap-1"><Text class="text-xs font-medium text-muted-foreground">{props.title}</Text><View class="rounded-md border border-border bg-card p-2"><Text class="font-mono text-xs text-foreground">{props.children}</Text></View></View>;
}

export function WebhookDeliveries(props: { task: ScheduledTask; request: (method: string, payload: unknown) => Promise<unknown>; onClose: () => void }) {
  const deliveries = signal<DeliverySummary[] | null>(null);
  const selected = signal<DeliveryDetail | null>(null);
  const loadingSelected = signal(false);
  const error = signal("");
  const refresh = async () => {
    deliveries.set(null);
    try { deliveries.set(readDeliveries(await props.request("scheduledTasks.listWebhookDeliveries", { id: props.task.id, acceptAnyOutcome: true }))); error.set(""); }
    catch (cause) { error.set(cause instanceof Error ? cause.message : String(cause)); deliveries.set([]); }
  };
  const open = async (id: string) => {
    loadingSelected.set(true);
    try { selected.set(readDelivery(await props.request("scheduledTasks.getWebhookDelivery", { id: props.task.id, deliveryId: id, acceptAnyOutcome: true }))); error.set(""); }
    catch (cause) { error.set(cause instanceof Error ? cause.message : String(cause)); }
    finally { loadingSelected.set(false); }
  };
  void refresh();
  const detail = () => selected();
  return (
    <SettingsDialog
      open
      onClose={props.onClose}
      title={`Deliveries · ${props.task.title}`}
      description="Recent requests to this task's webhook URL."
      width={672}
      testID="Webhook deliveries"
      footer={<>{detail() ? <SettingsButton label="Back" onPress={() => selected.set(null)} /> : <SettingsButton label="Refresh" disabled={deliveries() === null} onPress={() => void refresh()} />}<SettingsButton label="Done" tone="primary" onPress={props.onClose} /></>}
    >
      {error() ? <Text class="text-sm text-destructive-foreground">{error()}</Text> : null}
      {loadingSelected() && !detail() ? <Text class="text-sm text-muted-foreground">Loading delivery…</Text> : null}
      {detail() ? (
        <View class="gap-4">
          <View class="flex-row flex-wrap items-center gap-2">
            <View class="h-4.5 min-w-4.5 items-center justify-center rounded-sm border border-border px-1"><Text class="text-xs font-medium text-foreground">{deliveryLabel(detail()!)}</Text></View>
            <Text class="text-sm text-foreground">{`${detail()!.method} · ${new Date(detail()!.receivedAt).toLocaleString()}`}</Text>
            {detail()!.signatureVerified ? <Text class="text-sm text-muted-foreground">Signature verified</Text> : null}
          </View>
          {detail()!.error ? <Text class={`text-sm ${detail()!.outcome === "filtered" ? "text-muted-foreground" : "text-destructive-foreground"}`}>{detail()!.error}</Text> : null}
          <Block title={detail()!.pendingWindow ? "Scheduled run" : "Prompt sent to the agent"}>{detail()!.renderedPrompt ?? (detail()!.pendingWindow ? "Run scheduled when the window closes; no run started yet." : "No run was started for this request.")}</Block>
          {detail()!.missingFields.length > 0 ? <Text class="text-sm text-muted-foreground">{`Empty placeholders: ${detail()!.missingFields.join(", ")}`}</Text> : null}
          <Block title="Headers">{Object.entries(detail()!.headers).map(([name, value]) => `${name}: ${value}`).join("\n")}</Block>
          {detail()!.query ? <Block title="Query">{detail()!.query}</Block> : null}
          <Block title={detail()!.bodyTruncated ? "Body (truncated)" : "Body"}>{detail()!.body || "(empty)"}</Block>
        </View>
      ) : deliveries() === null ? (
        <Text class="text-sm text-muted-foreground">Loading deliveries…</Text>
      ) : deliveries()!.length === 0 ? (
        <Text class="text-sm text-muted-foreground">No requests yet.</Text>
      ) : (
        <View>
          <Each of={deliveries()!} key={(delivery) => delivery.id}>
            {(delivery) => (
              <View role="button" accessibilityLabel={`Open delivery ${delivery().id}`} onPress={() => void open(delivery().id)} class="flex-row flex-wrap items-center gap-2 border-b border-border py-2 hover:bg-accent-50">
                <View class="h-4.5 min-w-4.5 items-center justify-center rounded-sm border border-border px-1"><Text class="text-xs font-medium text-foreground">{deliveryLabel(delivery())}</Text></View>
                <Text class="text-sm text-foreground">{delivery().method}</Text>
                <Text class="text-sm text-muted-foreground">{new Date(delivery().receivedAt).toLocaleString()}</Text>
                {delivery().outcome === "filtered" && delivery().error ? <Text class="text-sm text-muted-foreground">{delivery().error}</Text> : null}
                {delivery().missingFields.length > 0 ? <Text class="text-sm text-muted-foreground">{`${delivery().missingFields.length} empty placeholder${delivery().missingFields.length === 1 ? "" : "s"}`}</Text> : null}
              </View>
            )}
          </Each>
        </View>
      )}
    </SettingsDialog>
  );
}
