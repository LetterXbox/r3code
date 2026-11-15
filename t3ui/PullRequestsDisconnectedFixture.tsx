// The Pull requests page with no connection, as the page draws it before an environment answers.
import { mount, View } from "nsh";
import { PullRequestsPage } from "./pages/PullRequests";

mount(() => (
  <View class="flex-1 flex-row bg-background">
    <PullRequestsPage request={async () => undefined} status={() => "disconnected"} hasProjects={() => false} debounceMs={0} />
  </View>
));
