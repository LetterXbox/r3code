// ComposerQueuedAttachmentRow (ComposerAttachmentStrip.tsx): the attachments of the queued message being edited, already
// uploaded, each a 64pt tile with a Remove button. An image tile shows the image, read through the signed-asset route like a sent
// message's thumbnail (the name stands in until it loads or when it cannot); any other attachment shows its name.
import { Text, View } from "nsh";
import { Thumbnail } from "../thread/MessageMedia";
import { readAttachment } from "../thread/readAttachment";
import type { MessageAttachment } from "../thread/AttachmentPreview";
import { ComposerIcon } from "./ComposerIcon";
import type { QueuedMessage } from "./runState";

export function QueuedAttachmentRow(props: { attachments: () => QueuedMessage["attachments"]; onRemove: (attachmentId: string) => void }) {
  return (
    <View class="mb-3 flex-row flex-wrap gap-2" testID="queued-attachments">
      <Each of={props.attachments()} key={(item) => item.id}>
        {(item) => (
          <View class="relative h-16 w-16 overflow-hidden rounded-lg border border-border-70 bg-background">
            {item().type === "image" ? (
              <View class="size-full" style={{ pointerEvents: "none" }}>
                <Thumbnail attachment={item() as MessageAttachment} load={readAttachment} class="size-full" onOpen={() => {}} />
              </View>
            ) : (
              <View class="h-full w-full items-center justify-center px-1">
                <Text class="text-center text-3xs text-muted-foreground line-clamp-3">{item().name}</Text>
              </View>
            )}
            <View onPress={() => props.onRemove(item().id)} accessibilityLabel={`Remove ${item().name}`} role="button" class="absolute right-1 top-1 size-5 items-center justify-center rounded-full bg-background">
              <ComposerIcon name="x" size={12} />
            </View>
          </View>
        )}
      </Each>
    </View>
  );
}
