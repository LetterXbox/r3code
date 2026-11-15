import { mount, signal, View } from "nsh";
import { BannerLane } from "./BannerLane";
import { providerStatus } from "./bannerFixtures";

// A chat area narrower than the 768pt card cap (right panel open, docked details card): the lane alert must stay
// inside the lane (reference max-w-[calc(100%-2rem)]) instead of spilling over the sidebar edge.
const status = signal({ ...providerStatus, instanceId: "codex", provider: "codex", displayName: "Codex", status: "warning", message: "Codex is slow to answer right now. Requests may take longer than usual while the service recovers from a partial outage." });

function Fixture() {
  return (
    <View class="flex-row h-[500px] w-[700px] bg-background">
      <View testID="Fake sidebar" class="w-[200px]" />
      <View class="relative h-[500px] w-[260px]">
        <BannerLane providerStatus={() => status()} rawProvider={() => null} thread={() => undefined} connected={() => true} insetEnd={() => 0} />
      </View>
      <View testID="Fake right panel" class="w-[240px]" />
    </View>
  );
}

mount(Fixture);
