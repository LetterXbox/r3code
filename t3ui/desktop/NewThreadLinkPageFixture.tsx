import { mount, View } from "nsh";
import { NewThreadLinkPage } from "./NewThreadLinkPage";
import { createNewThreadLinkController } from "./newThreadLink";
import { parseNewThreadLink } from "./promptLinkParse";

const result = parseNewThreadLink("?pr=acme/widgets%237&prompt=review");
const link = result.ok ? result.value : null;
const controller = createNewThreadLinkController({
  threads: () => [],
  projects: () => [{ id: "p", path: "/p", repositoryIdentity: { canonicalKey: "github.com/acme/widgets" } }],
  providers: () => [],
  openDraft: () => true,
  openThread: () => undefined,
  setModel: () => undefined,
  placePrompt: () => undefined,
  openScratch: async () => null,
  serverPullRequestThread: async () => null,
  cloneFacts: async () => ({ newProjectsRoot: null, destinationRoot: "", ghqCloneLayout: false }),
  startClone: async () => undefined,
  directoryPath: (url) => url,
  destinationPath: (root, dir) => `${root}/${dir}`,
  waitForProject: async () => true,
  suggestAppAccess: () => undefined,
  newId: () => "id",
  checkout: () => new Promise<boolean>(() => undefined),
  setDraft: () => undefined,
  warnHidden: () => undefined,
  toast: () => undefined,
});
if (link) void controller.open(link);

mount(() => (
  <View class="relative h-[300px] w-[500px] flex-row bg-background">
    <NewThreadLinkPage controller={controller} />
  </View>
));
