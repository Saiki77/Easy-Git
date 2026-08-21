import { App, ButtonComponent, Modal, Setting } from "obsidian";
import { FolderMapping } from "../types";
import { LocalOnlyCandidate, LocalOnlyScan } from "../sync/reconcile";
import { ConfirmModal } from "./confirm-modal";
import { markButtonDestructive } from "./button-compat";

export interface PruneLocalModalOptions {
  mapping: FolderMapping;
  /** Runs the remote and local scan. Called once, when the modal opens. */
  load: () => Promise<LocalOnlyScan>;
  /** Receives the selected mapping-relative paths after the user confirmed
   * in the second, destructive confirmation step. */
  onConfirm: (paths: string[]) => Promise<void>;
}

/**
 * Preview and selection step of "Prune local-only files". Lists every file
 * that exists in the mapping's vault folder but at none of its remotes,
 * tags the ones whose content is still on remote under another path (a
 * remote-side move), lets the user pick, and hands the selection to a
 * destructive ConfirmModal before anything is touched.
 */
export class PruneLocalModal extends Modal {
  private opts: PruneLocalModalOptions;
  private bodyEl!: HTMLElement;
  private candidates: LocalOnlyCandidate[] = [];
  private selected = new Set<string>();
  private checkboxes = new Map<string, HTMLInputElement>();
  private pruneButton?: ButtonComponent;

  constructor(app: App, opts: PruneLocalModalOptions) {
    super(app);
    this.opts = opts;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("easy-git-prune");
    contentEl.createEl("h2", { text: "Prune local-only files" });
    const folder = this.opts.mapping.vaultFolder || "(whole vault)";
    contentEl.createEl("p", {
      cls: "easy-git-prune-sub",
      text: `Mapping "${this.opts.mapping.name}", vault folder ${folder}. Files that exist here but at none of the mapping's remote destinations.`,
    });
    this.bodyEl = contentEl.createDiv();
    this.bodyEl.createEl("p", {
      cls: "easy-git-prune-sub",
      text: "Comparing the vault folder with remote…",
    });
    void this.run();
  }

  private async run(): Promise<void> {
    let scan: LocalOnlyScan;
    try {
      scan = await this.opts.load();
    } catch (e) {
      this.renderError(e instanceof Error ? e.message : String(e));
      return;
    }
    this.candidates = scan.candidates;
    this.selected = new Set(scan.candidates.map((c) => c.path));
    this.render(scan);
  }

  private renderError(message: string): void {
    this.bodyEl.empty();
    this.bodyEl.createEl("p", {
      cls: "easy-git-prune-error",
      text: `Could not compare with remote: ${message}`,
    });
    this.bodyEl.createEl("p", {
      cls: "easy-git-prune-sub",
      text: "Nothing was changed. Every destination has to be readable before anything can be pruned, otherwise its files would look local-only.",
    });
    new Setting(this.bodyEl).addButton((b) =>
      b.setButtonText("Close").onClick(() => this.close()),
    );
  }

  private render(scan: LocalOnlyScan): void {
    this.bodyEl.empty();
    this.checkboxes.clear();

    const remotesEl = this.bodyEl.createEl("ul", { cls: "easy-git-prune-remotes" });
    for (const r of scan.remotes) {
      remotesEl.createEl("li", {
        text: `${r.label} at ${r.headCommit.slice(0, 7)}: ${plural(r.fileCount, "file")}`,
      });
    }
    if (scan.remotes.some((r) => r.fileCount === 0)) {
      this.bodyEl.createEl("p", {
        cls: "easy-git-prune-warning",
        text: "One destination reports zero files. That usually means a wrong branch or remote folder, and it makes every local file look local-only. Check the destination before pruning anything.",
      });
    }

    if (this.candidates.length === 0) {
      this.bodyEl.createEl("p", {
        text: `Nothing to prune. All ${plural(scan.localFileCount, "file")} in the vault folder also exist on remote.`,
      });
      new Setting(this.bodyEl).addButton((b) =>
        b.setButtonText("Close").onClick(() => this.close()),
      );
      return;
    }

    const moved = this.candidates.filter((c) => c.sameContentAt.length > 0).length;
    const unique = this.candidates.length - moved;
    this.bodyEl.createEl("p", {
      text:
        `${plural(this.candidates.length, "local-only file")}. ` +
        `${moved} ${moved === 1 ? "has" : "have"} identical content on remote under another path (moved or renamed there). ` +
        `${unique} ${unique === 1 ? "contains" : "contain"} content that is not on remote.`,
    });
    this.bodyEl.createEl("p", {
      cls: "easy-git-prune-sub",
      text: 'Selected files are copied to .easy-git-backup/ first, then moved to trash following your Obsidian "Deleted files" setting. The remote is not touched.',
    });

    const bulk = new Setting(this.bodyEl).setName("Select");
    bulk.addButton((b) => b.setButtonText("All").onClick(() => this.setSelection(() => true)));
    bulk.addButton((b) => b.setButtonText("None").onClick(() => this.setSelection(() => false)));
    if (moved > 0 && unique > 0) {
      bulk.addButton((b) =>
        b
          .setButtonText("Only moved")
          .onClick(() => this.setSelection((c) => c.sameContentAt.length > 0)),
      );
    }

    const listEl = this.bodyEl.createDiv({ cls: "easy-git-prune-list" });
    for (const c of this.candidates) this.renderRow(listEl, c);

    new Setting(this.bodyEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => {
        this.pruneButton = b;
        markButtonDestructive(b);
        b.onClick(() => this.confirm());
      });
    this.refreshPruneButton();
  }

  private renderRow(parent: HTMLElement, c: LocalOnlyCandidate): void {
    const moved = c.sameContentAt.length > 0;
    const row = parent.createDiv({ cls: "easy-git-prune-row" });
    if (!moved) row.addClass("is-unique");
    const label = row.createEl("label", { cls: "easy-git-prune-check" });
    const box = label.createEl("input", { type: "checkbox" });
    box.checked = this.selected.has(c.path);
    label.createSpan({ cls: "easy-git-prune-path", text: c.path });
    row.createDiv({
      cls: "easy-git-prune-hint",
      text: moved
        ? `Same content on remote at ${describePaths(c.sameContentAt)}`
        : "Content not found on remote",
    });
    box.addEventListener("change", () => {
      if (box.checked) this.selected.add(c.path);
      else this.selected.delete(c.path);
      this.refreshPruneButton();
    });
    this.checkboxes.set(c.path, box);
  }

  private setSelection(keep: (c: LocalOnlyCandidate) => boolean): void {
    this.selected.clear();
    for (const c of this.candidates) {
      const on = keep(c);
      if (on) this.selected.add(c.path);
      const box = this.checkboxes.get(c.path);
      if (box) box.checked = on;
    }
    this.refreshPruneButton();
  }

  private refreshPruneButton(): void {
    const n = this.selected.size;
    this.pruneButton?.setButtonText(n === 0 ? "Prune" : `Prune ${plural(n, "file")}`);
    this.pruneButton?.setDisabled(n === 0);
  }

  private confirm(): void {
    const paths = this.candidates.map((c) => c.path).filter((p) => this.selected.has(p));
    if (paths.length === 0) return;
    const unique = this.candidates.filter(
      (c) => this.selected.has(c.path) && c.sameContentAt.length === 0,
    ).length;
    const message =
      `${plural(paths.length, "file")} will be copied to .easy-git-backup/ and then moved to trash.` +
      (unique > 0
        ? ` ${unique} of them ${unique === 1 ? "contains" : "contain"} content that is not on remote.`
        : "") +
      " Folders left empty are removed. Nothing changes on remote.";
    new ConfirmModal(this.app, {
      title: `Prune ${plural(paths.length, "file")}?`,
      message,
      confirmText: `Prune ${plural(paths.length, "file")}`,
      destructive: true,
      onConfirm: async () => {
        this.close();
        await this.opts.onConfirm(paths);
      },
    }).open();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function describePaths(paths: string[]): string {
  const shown = paths.slice(0, 2).join(", ");
  return paths.length > 2 ? `${shown} and ${paths.length - 2} more` : shown;
}
