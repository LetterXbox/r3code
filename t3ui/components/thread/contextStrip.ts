// BranchToolbar.logic.ts shouldShowComposerContextStrip. A new thread always shows the strip (it names the
// permissions the first send uses); a started thread only with `persistComposerContextStrip` (client setting,
// contract default false) and a git repo or a non-primary environment. The web assumes a git repo until the
// project's vcs status says otherwise.
export function shouldShowComposerContextStrip(input: {
  isDraftHeroState: boolean;
  persistInActiveThreads: boolean;
  hasActiveProject: boolean;
  isGitRepo?: boolean;
  showEnvironmentIndicator: boolean;
}): boolean {
  return input.hasActiveProject && (input.isDraftHeroState || (input.persistInActiveThreads && ((input.isGitRepo ?? true) || input.showEnvironmentIndicator)));
}
