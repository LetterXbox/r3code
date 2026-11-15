// The "Use T3 Code in another app (MCP)" dialog's open state (components/mcp/UseInAnotherAppDialog.tsx
// requestAtom). The palette opens it from anywhere; the host mounts once.
import { signal } from "nsh";

const requested = signal(false);

export const useInAnotherAppOpen = () => requested();
export function openUseInAnotherApp(): void {
  requested.set(true);
}
export function closeUseInAnotherApp(): void {
  requested.set(false);
}

/** The gate the dialog shows before its wizard: no environment, or no T3 Connect in this build. */
export function mcpGateTitle(environmentLabel: string | null): { title: string; message: string } {
  const label = environmentLabel ?? "R3 Code";
  return {
    title: `Use R3 Code in another app (MCP) · ${label}`,
    // The second line shows only in a build without the public T3 Connect configuration (hasCloudPublicConfig false).
    message: environmentLabel === null ? "Connect to an environment first." : "T3 Connect is not available in this build.",
  };
}
