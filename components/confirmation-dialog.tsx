"use client";

import { ConfirmDialog, confirmDialog } from "primereact/confirmdialog";

type ConfirmationOptions = {
  message: string;
  accept: () => void | Promise<void>;
  reject?: () => void;
  header?: string;
  acceptLabel?: string;
  rejectLabel?: string;
  severity?: "danger" | "primary";
};

/** A single app-wide replacement for blocking browser confirmation dialogs. */
export function requestConfirmation({
  message,
  accept,
  reject,
  header = "Confirm action",
  acceptLabel = "Continue",
  rejectLabel = "Cancel",
  severity = "danger"
}: ConfirmationOptions) {
  confirmDialog({
    header,
    message,
    icon: severity === "danger" ? "pi pi-exclamation-triangle" : "pi pi-question-circle",
    accept,
    reject,
    acceptLabel,
    rejectLabel,
    acceptClassName: severity === "danger" ? "p-button-danger" : undefined,
    className: "app-confirm-dialog",
    dismissableMask: true,
    closeOnEscape: true
  });
}

export function AppConfirmationDialog() {
  return <ConfirmDialog />;
}
