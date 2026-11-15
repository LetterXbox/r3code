// ProjectSettingsPanel.logic.ts and the project mutations of ProjectSettingsPanel.tsx. The commands are the
// contract's ProjectMutation (project.update | project.delete) sent through `projects.mutate`.
import type { ProjectIcon } from "../../components/sidebar/projectIcon";

/** SCRATCH_PROJECT_TITLE: the name a scratch project starts with. */
export const SCRATCH_PROJECT_TITLE = "Scratch";

/** The Project icon row's description: the override spelled out, else the favicon path, else Automatic. */
export function projectIconDescription(icon: ProjectIcon | null, faviconPath: string | null): string {
  if (icon?.kind === "lucide") return `${icon.name} · ${icon.color}`;
  if (icon?.kind === "monogram") return `${icon.text} · ${icon.color}`;
  if (icon?.kind === "emoji") return icon.emoji;
  return faviconPath ?? "Automatic";
}

/** A rename is sent only when the name changed (projectGroupTitleNeedsUpdate). */
export function projectTitleNeedsUpdate(currentTitle: string, nextTitle: string, wasEdited: boolean): boolean {
  return wasEdited && nextTitle.trim() !== currentTitle;
}

const commandId = () => `command:${crypto.randomUUID()}`;

export const projectUpdate = (projectId: string, fields: Record<string, unknown>) => ({ type: "project.update", commandId: commandId(), projectId, ...fields });
export const projectDelete = (projectId: string) => ({ type: "project.delete", commandId: commandId(), projectId, force: true });

/** planProjectRemoval's confirmation for one project. */
export function removeProjectMessage(name: string, threadCount: number): string {
  return [
    `Remove ${name}?`,
    `This deletes the project entry, ${threadCount > 0 ? `its ${threadCount} ${threadCount === 1 ? "thread" : "threads"}` : "all its active and archived threads"}, and its unsent drafts. Files on disk are not touched. This cannot be undone.`,
  ].join("\n");
}

export interface RemovalMember { id: string; environmentId: string; title: string; workspaceRoot: string; environmentLabel?: string | null }

/**
 * planProjectRemoval (client-runtime/state/projectRemoval.ts): what removing some of a project group's checkouts
 * says and does. `threadCount` is the listed threads of the members (side chats and subagents go with their parent).
 */
export function planProjectRemoval(options: { members: readonly RemovalMember[]; groupMemberCount: number; hasOtherMembers: boolean; displayName: string; threadCount: number }) {
  const { members, groupMemberCount, hasOtherMembers, displayName, threadCount } = options;
  const isWholeGroup = members.length === groupMemberCount;
  const targetKind = hasOtherMembers || !isWholeGroup ? "checkout" : "project";
  const singleMember = members.length === 1 ? members[0]! : null;
  const targetLabel = singleMember?.title ?? displayName;
  const confirmationMessage = [
    threadCount > 0
      ? `Remove ${targetKind} "${targetLabel}" and delete its ${threadCount} thread${threadCount === 1 ? "" : "s"}?`
      : `Remove ${targetKind} "${targetLabel}"?`,
    ...(singleMember
      ? [`Path: ${singleMember.workspaceRoot}`, ...(singleMember.environmentLabel ? [`Environment: ${singleMember.environmentLabel}`] : [])]
      : [`This removes ${members.length} grouped project entries.`]),
    threadCount > 0
      ? "Those threads and any archived threads are deleted from R3 Code. Provider sessions are kept."
      : "Any archived threads are deleted from R3 Code. Provider sessions are kept.",
    isWholeGroup && !hasOtherMembers ? "This removes only the project entries, not the files on disk." : "Other entries in this grouped project are unaffected.",
    "This action cannot be undone.",
  ].join("\n");
  return { isWholeGroup, targetKind, confirmationMessage };
}

/** The Danger row of a project group: its title, description and button (ProjectSettingsPanel.tsx). */
export function dangerRowCopy(memberCount: number, hasOtherMembers: boolean) {
  if (hasOtherMembers) return { title: "Remove checkout", description: "Deletes the selected machine's checkout entries and their threads. Other machines and files on disk are not touched.", button: "Remove checkout" };
  if (memberCount > 1) return { title: "Remove this project everywhere", description: `Deletes all ${memberCount} checkout entries and their threads on every machine. Files on disk are not touched.`, button: "Remove all entries" };
  return { title: "Remove project", description: "Deletes the project entry and its threads. Files on disk are not touched.", button: "Remove project" };
}
