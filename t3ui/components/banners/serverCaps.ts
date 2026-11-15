// The connected server's execution-environment capabilities (ExecutionEnvironmentDescriptor.capabilities).
import { serverEnvironment } from "../../pages/settings/settingsState";

export const serverEnvironmentCapabilities = () => ((serverEnvironment()?.capabilities ?? {}) as Record<string, unknown>);
export const serverEnvironmentLabel = () => { const label = serverEnvironment()?.label; return typeof label === "string" && label ? label : "Environment"; };
