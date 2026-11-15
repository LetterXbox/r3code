import { mount, View } from "nsh";
import { WebhookDeliveryMode } from "./TaskEditorDialog";

mount(() => (
  <View class="flex-1 gap-2 p-4">
    <WebhookDeliveryMode read={() => Promise.resolve({ holdWebhooksWhileOffline: true })} />
    <WebhookDeliveryMode read={() => Promise.resolve({ holdWebhooksWhileOffline: false })} />
    <WebhookDeliveryMode read={() => Promise.reject(new Error("not linked"))} />
  </View>
));
