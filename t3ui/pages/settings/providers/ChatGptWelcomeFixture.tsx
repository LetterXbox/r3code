import { mount, View } from "nsh";
import { ChatGptWelcomeHost, sharingProfiles } from "./ChatGptWelcome";

const provider = { instanceId: "codex", displayName: "Codex", auth: { status: "authenticated", type: null, label: null, email: "fixture-welcome@example.com", canLogout: true, action: null, subscriptionSharing: true } };
mount(() => <View class="flex-1"><ChatGptWelcomeHost profiles={() => sharingProfiles("env-fixture", "Studio Mac", [provider as never])} /></View>);
