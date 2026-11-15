import { expect, test } from "nsh/test";
import { completeRelayClientInstallDialogClose, finishRelayClientInstall, relayClientInstallDialogState, reportRelayClientInstallProgress, requestRelayClientInstallConfirmation, respondToRelayClientInstallConfirmation } from "./RelayClientInstallDialog";

test("the relay client install dialog confirms, follows progress, and closes", async () => {
  const answer = requestRelayClientInstallConfirmation("1.0.0");
  expect(relayClientInstallDialogState().status).toBe("confirming");
  await expect(requestRelayClientInstallConfirmation("2.0.0")).rejects.toThrow();
  respondToRelayClientInstallConfirmation(true);
  expect(await answer).toBe(true);
  reportRelayClientInstallProgress({ type: "progress", stage: "downloading" });
  const state = relayClientInstallDialogState();
  expect(state.status === "installing" && state.stage).toBe("downloading");
  finishRelayClientInstall();
  expect(relayClientInstallDialogState().status).toBe("closing");
  completeRelayClientInstallDialogClose();
  expect(relayClientInstallDialogState().status).toBe("idle");
});
