// "Start without a project" (useScratchProject.ts): ensure the environment's Scratch project, then
// open a draft thread in it. Offered only when the server config names a scratch workspace root.
import { signal } from "nsh";
import { factsFromConfig } from "../sidebar/serverFacts";
import { showToast } from "../toast/toastState";
import { allProjects, backendConnectionGeneration, backendStatus, backendUrl, createThread, requestBackend } from "../../store";

const available = signal(false);
let loadedKey = "";

/** Whether the connected environment offers a scratch project (server.getConfig scratchWorkspaceRoot). */
export function scratchProjectAvailable(): boolean {
  if (backendStatus() !== "connected") return false;
  const key = `${backendUrl()}|${backendConnectionGeneration()}`;
  if (key !== loadedKey) {
    loadedKey = key;
    available.set(false);
    void requestBackend("server.getConfig", {}).then((config) => {
      if (loadedKey === key) available.set(factsFromConfig(config).scratchRoot !== null);
    }).catch(() => {
      if (loadedKey === key) loadedKey = "";
    });
  }
  return available();
}

/** projects.ensureScratch answers with the project's id. */
export function scratchProjectId(reply: unknown): string | null {
  const record = typeof reply === "object" && reply !== null ? (reply as Record<string, unknown>) : null;
  return typeof record?.projectId === "string" && record.projectId ? record.projectId : null;
}

let starting = false;

/**
 * projectEnvironment.openScratch: ensures the environment's Scratch project and waits (10 s at most) for it to reach
 * the store through the event stream; its id, or a throw.
 */
export async function openScratchProject(options: { attempts?: number; delayMs?: number } = {}): Promise<string> {
  const projectId = scratchProjectId(await requestBackend("projects.ensureScratch", {}));
  if (!projectId) throw new Error("The server did not return a scratch project.");
  const attempts = options.attempts ?? 40;
  for (let attempt = 0; attempt < attempts && !allProjects().some((project) => project.id === projectId); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 250));
  }
  if (!allProjects().some((project) => project.id === projectId)) throw new Error(SCRATCH_NOT_LOADED_MESSAGE);
  return projectId;
}

/** ScratchProjectNotLoadedError's message: the 10 s wait for the project to reach the client store ran out. */
export const SCRATCH_NOT_LOADED_MESSAGE = "The folder for threads without a project has not reached this device yet. Try again.";

/**
 * useScratchProject openScratchProject + startScratchThread: a failure at any step (the call, the project never reaching
 * the store, the draft) is one error toast, "Could not start without a project", and nothing opens.
 */
export async function startWithoutProject(options: { attempts?: number; delayMs?: number } = {}): Promise<boolean> {
  if (starting) return false;
  starting = true;
  try {
    createThread(await openScratchProject(options));
    return true;
  } catch (error) {
    showToast({ type: "error", title: "Could not start without a project", description: error instanceof Error && error.message.trim().length > 0 ? error.message : "An error occurred." });
    return false;
  } finally {
    starting = false;
  }
}
