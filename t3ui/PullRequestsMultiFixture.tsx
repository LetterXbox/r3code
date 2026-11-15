import { mount } from "nsh";
import { PullRequestsPage } from "./pages/PullRequests";
import { createPullRequestMultiEnvironment } from "./components/pullRequest/pullRequestMultiEnvironment";
import { replaceServerSettings } from "./pages/settings/settingsState";

replaceServerSettings({});

const environments = [{ id: "local", label: "Laptop", connected: true }, { id: "remote", label: "Server", connected: true }];
const environmentForProject = (id: string) => id.startsWith("remote:") ? "remote" : "local";
const api = createPullRequestMultiEnvironment({ environments: () => environments, environmentForProject, request: async (id, method) => {
  if (method === "pullRequests.list") return { entries: [{ projectId: id === "local" ? "p" : "remote:p", host: "github.com", repository: "org/repo", number: 1, title: id === "local" ? "Laptop change" : "Server change", url: `https://example.com/${id}`, state: "open", author: { login: id === "local" ? "alice" : "bob" } }], errors: [], nextCursors: {}, viewers: { "github.com": id === "local" ? "alice" : "bob" }, providers: [] };
  return method === "pullRequests.listStats" ? { stats: [] } : { authors: [], labels: [] };
} });
mount(() => <PullRequestsPage request={async () => ({})} status={() => "connected"} hasProjects={() => true} projects={() => [{ id: "p", title: "Laptop project" }, { id: "remote:p", title: "Server project" }]} environments={() => environments} environmentForProject={environmentForProject} multiEnvironment={api} />);
