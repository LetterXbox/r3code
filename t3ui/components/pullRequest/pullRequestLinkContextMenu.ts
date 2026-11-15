// The right-click menu of a pull request link (pullRequestLinkContextMenu.ts): Copy link and Open on the host.
export type PullRequestLinkContextMenuAction = "copy-link" | "open-external";

const HOST_LABELS: Record<string, string> = {
  github: "GitHub", gitlab: "GitLab", bitbucket: "Bitbucket", "azure-devops": "Azure DevOps", forgejo: "Forgejo", gitcafe: "GitCafe", "cursor-origin": "Cursor Origin",
};

/** openOnHostLabel: "Open on GitHub", or "Open on host" for a host the app does not know. */
export const openOnHostLabel = (provider: string): string => (HOST_LABELS[provider] ? `Open on ${HOST_LABELS[provider]}` : "Open on host");

export const pullRequestLinkContextMenuItems = (openLabel: string): { id: PullRequestLinkContextMenuAction; label: string }[] => [
  { id: "copy-link", label: "Copy link" },
  { id: "open-external", label: openLabel },
];
