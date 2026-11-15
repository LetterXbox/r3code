import { mount, Text, View } from "nsh";
import { createPullRequestLinkPreviewModel, PullRequestLinkPreview } from "./PullRequestLinkPreview";

const model = createPullRequestLinkPreviewModel({
  request: async () => ({ projectId: "p1", repository: "acme/t3code", number: 12, title: "Fix the thing", url: "https://github.com/acme/t3code/pull/12", author: { login: "octocat", name: "" }, state: "open", isDraft: false, createdAt: "2026-11-01T00:00:00.000Z" }),
  projectId: () => "p1", openInApp: () => false, openOnHost: () => {},
});

function App() {
  return (
    <View class="p-2">
      <Text onPress={() => model.handle("https://github.com/acme/t3code/pull/12")}>Link</Text>
      <PullRequestLinkPreview model={model} now={() => Date.parse("2026-11-02T00:00:00.000Z")} scheme="dark" />
    </View>
  );
}

mount(App);
