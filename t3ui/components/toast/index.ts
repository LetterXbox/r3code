// The app-wide toast and confirmation hosts. Mount `ToastHost` and `ConfirmDialogHost` once (App.tsx); any module raises a
// toast with `showToast({ type, title, description, actions })` and asks with `await confirm("Delete this thread?\nIt cannot be undone.", { variant: "destructive" })`.
export { ToastHost } from "./ToastHost";
export { ConfirmDialogHost } from "./ConfirmDialogHost";
export { confirm, type ConfirmDialogOptions, type ConfirmDialogVariant } from "./confirmDialog";
export { closeToast, errorToast, showToast, updateToast, type ToastAction, type ToastInput, type ToastType } from "./toastState";
export { AnchoredToastHost } from "./AnchoredToastHost";
export { showAnchoredCopyErrorToast, showAnchoredCopySuccessToast, showAnchoredToast, type ToastAnchor } from "./anchoredToast";
