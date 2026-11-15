// The root coordinators App.tsx starts once: what the web mounts at its root (routes/__root.tsx) and has no visible markup.
import { installShellCommands } from "../../commands/shellCommands";
import { installFirstRunGate } from "../onboarding/firstRunState";
import { installConnectionCoordinator } from "./connectionCoordinator";
import { installLifecycleToasts } from "./lifecycleToasts";
import { installPermissionUpdateNotice } from "./permissionNotice";
import { installServerStreams } from "./serverStreams";
import { configureStarPrompt } from "./githubStarPrompt";
import { installDesktopUpdateToast } from "./desktopUpdate";
import { backendStatus, openSettings, requestBackend, settingsOpen, settingsSection, shellSnapshotLoaded } from "../../store";
import { installSnapShotSetupResume } from "../../pages/settings/snapshots/setupResume";
import { installSlowRpcToasts } from "./rpcLatency";
import { installThreadNotifications } from "./threadNotificationCoordinator";
import { installProactivePanels } from "./proactivePanels";
import { installPullRequestRouting } from "../pullRequest/pullRequestRoutingInstall";
import { installThreadLinkedPullRequest } from "../pullRequest/threadLinkedPullRequest";
import { installFileMetadataInvalidation } from "../files/fileMetadata";
import { installFileSurfaceReconcile } from "../rightPanel/panelState";
import { installBootstrapNavigation } from "./bootstrapNavigation";
import { installRunningThreadKeepAlive } from "./runningThreadKeepAlive";
import { installIndexDraftLanding } from "./indexDraftLanding";
import { installWebLinks } from "../../desktop/webLinks";
import { installWindowBounds } from "../../desktop/windowBounds";
import { startCliFirstLaunch } from "../../desktop/cliCommand";
import { installAppActivationListener } from "../../desktop/appActivationCoordinator";
import { installManagedPolicyCheck } from "../../desktop/managedPolicy";
import { installDraftLoadBalancing } from "../../environments/loadBalancing";
import { installBackgroundActivityReporter } from "./backgroundActivity";
import { installBrowserProfileReporting } from "../rightPanel/desktopPreviewSessions";
import { canOperatePreview } from "../rightPanel/previewScope";
import { backendConnectionGeneration, backendUrl, environmentSupportsServerBrowser } from "../../store";

export function installRootCoordinators() {
  configureStarPrompt(requestBackend);
  installServerStreams();
  installDesktopUpdateToast();
  installFirstRunGate();
  installLifecycleToasts();
  installConnectionCoordinator();
  installThreadNotifications();
  installSlowRpcToasts();
  installPermissionUpdateNotice();
  installShellCommands();
  installProactivePanels();
  installPullRequestRouting();
  installThreadLinkedPullRequest();
  installFileMetadataInvalidation();
  installFileSurfaceReconcile(shellSnapshotLoaded);
  installBootstrapNavigation();
  installRunningThreadKeepAlive();
  installIndexDraftLanding();
  installWebLinks();
  installWindowBounds();
  // DesktopCliCommand.installOnFirstLaunch: once per install, not awaited; a failure is left to Settings' own row.
  startCliFirstLaunch();
  // DesktopAppActivation: `t3 <path>` hands off to this window over ~/.t3codegpui/activation (file-drop; NSH has no
  // listening sockets). Starts its own poll/heartbeat loop; nothing to await here.
  installAppActivationListener();
  // DesktopManagedPolicy: the OS-deployed policy, read once; one that cannot be used is reported (DesktopStartupRecovery).
  installManagedPolicyCheck();
  installDraftLoadBalancing();
  installBackgroundActivityReporter();
  installBrowserProfileReporting({ connected: () => backendStatus() === "connected", connectionKey: () => `${backendUrl()}|${backendConnectionGeneration()}`, canOperate: canOperatePreview, serverBrowser: environmentSupportsServerBrowser });
  installSnapShotSetupResume({ connected: () => backendStatus() === "connected", currentPath: () => (settingsOpen() ? settingsSection() : null), open: openSettings });
}
