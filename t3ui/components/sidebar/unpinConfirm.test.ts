import { expect, test } from "nsh/test";
import { updateSetting } from "../../store";
import { attachConfirmDialogHost, confirmDialogState, resetConfirmDialogForTests, respondToConfirmDialog } from "../toast/confirmDialog";
import { threadUndo, unpinThreadWithUndo } from "./threadActions";

test("fm13: with confirmThreadUnpin on, unpinning asks first and keeping the pin changes nothing", async () => {
  resetConfirmDialogForTests();
  const detach = attachConfirmDialogHost();
  updateSetting("confirmThreadUnpin", true);
  const result = unpinThreadWithUndo({ id: "t-unpin", title: "Fix login" });
  const state = confirmDialogState() as { status: string; message?: string };
  expect(state.status).toBe("confirming");
  expect(state.message).toBe('Unpin thread "Fix login"?\nThis will move the thread out of your pinned section.');
  respondToConfirmDialog(false);
  expect(await result).toBe(false);
  expect(threadUndo.notice()).toBeNull();
  updateSetting("confirmThreadUnpin", false);
  detach();
});
