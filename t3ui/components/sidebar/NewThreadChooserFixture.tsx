import { mount, Text, View } from "nsh";
import { applyShellEventForTest, openThread } from "../../store";
import { CommandPalette } from "../CommandPalette";
import { Sidebar } from "../Sidebar";
import { startNewThread } from "../../commands/standardCommands";

const iso = "2026-01-01T00:00:00.000Z";
const projects = ["Alpha", "Beta"].map((title, index) => ({ id: `p${index}`, title, workspaceRoot: `/w/${title}`, createdAt: iso, updatedAt: iso }));
const snapshot = (rows: typeof projects) => applyShellEventForTest({ kind: "snapshot", snapshot: { projects: rows, threads: [] } });
snapshot(projects);
mount(() => <View class="flex-1 flex-row"><Sidebar /><View><View role="button" accessibilityLabel="Leave one project" onPress={() => snapshot(projects.slice(0, 1))}><Text>One project</Text></View><View role="button" accessibilityLabel="Remove all projects" onPress={() => snapshot([])}><Text>No projects</Text></View><View role="button" accessibilityLabel="Group projects" onPress={() => snapshot(projects.map((project) => ({ ...project, repositoryIdentity: { canonicalKey: "github.com/example/repo", displayName: "repo", rootPath: "/w/Alpha" } })))}><Text>Group projects</Text></View><View role="button" accessibilityLabel="Add grouped and separate projects" onPress={() => snapshot([...projects.map((project) => ({ ...project, repositoryIdentity: { canonicalKey: "github.com/example/repo", displayName: "repo", rootPath: "/w/Alpha" } })), { id: "p2", title: "Gamma", workspaceRoot: "/w/Gamma", createdAt: iso, updatedAt: iso }])}><Text>Grouped and separate</Text></View><View role="button" accessibilityLabel="Run new thread command" onPress={startNewThread}><Text>New thread command</Text></View><Text>{`Selected project: ${openThread()?.projectId ?? "none"}`}</Text></View><CommandPalette /></View>);
