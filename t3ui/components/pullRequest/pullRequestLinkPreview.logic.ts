// What a pull request link in text shows before it opens (PullRequestLinkPreview.tsx): the link names a repository and a number,
// pullRequests.preview answers with the card (PullRequestPreview in packages/contracts pullRequest.ts).
export interface LinkedPullRequest { host: string; repository: string; number: number }

/** `.../pull/7`, `.../pulls/7`, `.../-/merge_requests/7` and Azure's `.../pullrequest/7`; null for any other link. */
export function parsePullRequestLink(url: string): LinkedPullRequest | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const match = /^\/(.+?)\/(?:-\/)?(?:pull|pulls|merge_requests|pullrequest)\/(\d+)\/?$/u.exec(parsed.pathname);
  if (!match?.[1] || !match[2]) return null;
  return { host: parsed.hostname, repository: match[1].replace(/\/_git\//u, "/"), number: Number(match[2]) };
}

export interface PullRequestPreviewCard {
  repository: string; number: number; title: string; url: string; state: string; isDraft: boolean;
  author: { login: string; name: string } | null; createdAt: string;
}

export function parsePullRequestPreview(value: unknown): PullRequestPreviewCard {
  const body = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const author = typeof body.author === "object" && body.author !== null ? body.author as Record<string, unknown> : null;
  if (typeof body.title !== "string" || typeof body.number !== "number" || typeof body.repository !== "string") throw new Error("The server returned an invalid pull request preview.");
  return {
    repository: body.repository, number: body.number, title: body.title, url: typeof body.url === "string" ? body.url : "", state: typeof body.state === "string" ? body.state : "open",
    isDraft: body.isDraft === true, createdAt: typeof body.createdAt === "string" ? body.createdAt : "",
    author: author && typeof author.login === "string" ? { login: author.login, name: typeof author.name === "string" ? author.name : "" } : null,
  };
}

/** The author line: a deleted account is "ghost", a distinct display name reads "Name (@login)". */
export function previewAuthorLabel(author: PullRequestPreviewCard["author"]): string {
  if (author === null) return "ghost";
  return author.name && author.name !== author.login ? `${author.name} (@${author.login})` : author.login;
}
