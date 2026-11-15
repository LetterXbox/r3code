// The copy and buttons of each NewThreadLinkView state (promptLinks/NewThreadLinkView.tsx), kept apart from the drawing so a
// test reads exactly what the user is told.
import type { NewThreadLinkController, NewThreadLinkState } from "./newThreadLink";

export interface LinkPageAction { label: string; primary: boolean; disabled: boolean; run: (controller: NewThreadLinkController) => void }
export interface LinkPageView { title: string; description?: string; actions: LinkPageAction[] }

export function linkPageView(state: NewThreadLinkState | null, checkingOut: boolean, controller?: { link: () => { kind: string; pullRequest?: { owner: string; name: string; number: number } } | null }): LinkPageView | null {
  if (state === null) return null;
  switch (state.status) {
    case "opening":
      return { title: "Opening the link...", actions: [] };
    case "failed":
      return { title: state.title ?? "Could not open the link", description: state.message, actions: [] };
    case "missing-repository": {
      const name = `${state.repository.owner}/${state.repository.name}`;
      return {
        title: `You don't have ${name}`,
        description: "Clone it to work on it here, or start without a project.",
        actions: [
          { label: `Clone ${name}`, primary: true, disabled: false, run: (c) => void c.cloneRepository(state.repository) },
          { label: "Use without project", primary: false, disabled: false, run: (c) => c.useWithoutProject() },
        ],
      };
    }
    case "pull-request-checkout": {
      const pullRequest = controller?.link()?.pullRequest;
      const reference = pullRequest ? `${pullRequest.owner}/${pullRequest.name}#${pullRequest.number}` : "";
      return {
        title: `Check out ${reference}?`,
        description: "This puts the pull request's code in a new worktree and runs your project's setup script on it.",
        actions: [{ label: checkingOut ? "Checking out..." : "Check out", primary: true, disabled: checkingOut, run: (c) => void c.checkout() }],
      };
    }
  }
}
