// DraftStartError (apps/web/src/routes/_chat.index.tsx): the root view when starting the landing draft failed.
import { Image, Text, View } from "nsh";
import refreshIcon from "../components/pullRequest/icons/refresh-cw.svg";
import { retryDraftStart } from "../components/coordinators/indexDraftLanding";

export function DraftStartError() {
  return (
    <View class="min-w-0 flex-1 items-center justify-center gap-6 p-12">
      <View class="w-full max-w-md items-center">
        <Text class="text-center text-xl font-semibold text-foreground">Couldn’t start a new thread</Text>
        <Text class="mt-1 text-center text-sm text-muted-foreground">The project is still available. Try opening the draft again.</Text>
        <View class="mt-5 flex-row justify-center">
          <View
            role="button"
            accessibilityLabel="Try again"
            onPress={retryDraftStart}
            class="h-8 flex-row items-center justify-center gap-1.5 rounded-lg bg-primary px-2.5 active:scale-[0.97] transition-transform duration-150 ease-in-out"
          >
            <Image src={refreshIcon} fadeDuration={0} style={{ width: 16, height: 16, tintColor: "#ffffff" }} />
            <Text class="text-sm font-medium text-primary-foreground">Try again</Text>
          </View>
        </View>
      </View>
    </View>
  );
}
