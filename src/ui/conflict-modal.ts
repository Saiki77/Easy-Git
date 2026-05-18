import { App, Modal, Setting } from "obsidian";
import { ConflictEntry, ConflictResolution } from "../types";

export interface ConflictModalResult {
  resolutions: ConflictEntry[];
  applied: boolean;
}

export class ConflictResolutionModal extends Modal {
  private conflicts: ConflictEntry[];
  private mappingName: string;
  private resolver: (result: ConflictModalResult) => void;
  private resolved = false;

  constructor(
    app: App,
    mappingName: string,
    conflicts: ConflictEntry[],
    onDone: (result: ConflictModalResult) => void,
  ) {
    super(app);
    this.mappingName = mappingName;
    this.conflicts = conflicts.map((c) => ({ ...c, resolution: c.resolution }));
    this.resolver = onDone;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Resolve sync conflicts" });
    contentEl.createEl("p", {
      text: `${this.conflicts.length} file${this.conflicts.length === 1 ? "" : "s"} changed on both sides of "${this.mappingName}". Choose what to keep for each.`,
    });

    const listEl = contentEl.createDiv({ cls: "easy-git-conflict-list" });
    for (const c of this.conflicts) {
      this.renderConflictRow(listEl, c);
    }

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText("Cancel sync")
          .onClick(() => {
            this.resolved = true;
            this.resolver({ resolutions: [], applied: false });
            this.close();
          }),
      )
      .addButton((b) =>
        b
          .setCta()
          .setButtonText("Apply resolutions")
          .onClick(() => {
            if (this.conflicts.some((c) => !c.resolution)) {
              const next = b.buttonEl;
              next.classList.add("mod-warning");
              next.setText("Pick a choice for every file first");
              setTimeout(() => {
                next.classList.remove("mod-warning");
                next.setText("Apply resolutions");
              }, 1800);
              return;
            }
            this.resolved = true;
            this.resolver({ resolutions: this.conflicts, applied: true });
            this.close();
          }),
      );
  }

  private renderConflictRow(parent: HTMLElement, c: ConflictEntry): void {
    const row = parent.createDiv({ cls: "easy-git-conflict-row" });
    row.createDiv({ cls: "easy-git-conflict-path", text: c.path });
    row.createDiv({
      cls: "easy-git-conflict-kind",
      text: describeConflictKind(c),
    });
    const choices = row.createDiv({ cls: "easy-git-conflict-choices" });
    const group = `conflict-${c.path}-${Math.random().toString(36).slice(2, 8)}`;
    for (const choice of ["keep-local", "keep-remote", "keep-both"] as const) {
      if (!isChoiceValid(c.kind, choice)) continue;
      const label = choices.createEl("label", { cls: "easy-git-conflict-choice" });
      const radio = label.createEl("input", { type: "radio" });
      radio.name = group;
      radio.value = choice;
      if (c.resolution === choice) radio.checked = true;
      label.createSpan({ text: describeChoice(c.kind, choice) });
      radio.addEventListener("change", () => {
        c.resolution = choice;
      });
    }
  }

  onClose(): void {
    if (!this.resolved) {
      this.resolver({ resolutions: [], applied: false });
    }
    this.contentEl.empty();
  }
}

function describeConflictKind(c: ConflictEntry): string {
  switch (c.kind) {
    case "both-edited":
      return "Edited on both sides";
    case "both-added-different":
      return "Added on both sides with different content";
    case "local-edited-remote-deleted":
      return "Edited locally; deleted on remote";
    case "remote-edited-local-deleted":
      return "Edited on remote; deleted locally";
  }
}

function isChoiceValid(
  kind: ConflictEntry["kind"],
  choice: ConflictResolution,
): boolean {
  if (choice === "keep-both") {
    return kind === "both-edited" || kind === "both-added-different";
  }
  return true;
}

function describeChoice(
  kind: ConflictEntry["kind"],
  choice: ConflictResolution,
): string {
  if (choice === "keep-local") {
    return kind === "local-edited-remote-deleted"
      ? "Restore on remote (keep local)"
      : "Keep local";
  }
  if (choice === "keep-remote") {
    return kind === "remote-edited-local-deleted"
      ? "Restore locally (keep remote)"
      : "Keep remote";
  }
  return "Keep both (rename local copy)";
}
