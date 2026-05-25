import { App, Modal, Setting } from "obsidian";
import { SyncLogEntry } from "../types";

export interface SyncLogModalOptions {
  entries: SyncLogEntry[];
  onClear: () => void | Promise<void>;
}

/**
 * Read-only viewer for recent sync activity. Shows newest first, with a
 * collapsible body per entry holding error detail and the list of changed
 * file paths so the user can see exactly what hung up.
 */
export class SyncLogModal extends Modal {
  private opts: SyncLogModalOptions;

  constructor(app: App, opts: SyncLogModalOptions) {
    super(app);
    this.opts = opts;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("easy-git-sync-log");

    contentEl.createEl("h2", { text: "Sync log" });
    if (this.opts.entries.length === 0) {
      contentEl.createEl("p", {
        text: "No sync activity recorded yet. Trigger a sync from the ribbon or settings to populate the log.",
        attr: { style: "color: var(--text-muted);" },
      });
      this.renderFooter(contentEl);
      return;
    }
    contentEl.createEl("p", {
      text: `Most recent ${this.opts.entries.length} sync run${
        this.opts.entries.length === 1 ? "" : "s"
      } across all mappings. Newest first.`,
      attr: { style: "color: var(--text-muted); margin-bottom: 1rem;" },
    });

    const listEl = contentEl.createDiv({ cls: "easy-git-log-list" });
    for (const entry of this.opts.entries) {
      this.renderEntry(listEl, entry);
    }
    this.renderFooter(contentEl);
  }

  private renderEntry(parent: HTMLElement, entry: SyncLogEntry): void {
    const row = parent.createDiv({ cls: "easy-git-log-row" });
    if (!entry.ok) row.addClass("is-error");

    const header = row.createDiv({ cls: "easy-git-log-header" });
    header.createSpan({
      cls: "easy-git-log-status",
      text: entry.ok ? "✓" : "✗",
    });
    const meta = header.createDiv({ cls: "easy-git-log-meta" });
    meta.createDiv({
      cls: "easy-git-log-title",
      text: `${entry.mappingName} → ${entry.destinationLabel}`,
    });
    meta.createDiv({
      cls: "easy-git-log-sub",
      text: `${formatRelative(entry.timestamp)} · trigger: ${entry.trigger} · ${entry.durationMs}ms`,
    });
    const summaryText = entry.ok
      ? entry.filesTouched === 0
        ? "up to date"
        : `${entry.added}+ ${entry.modified}~ ${entry.deleted}-`
      : "error";
    header.createSpan({ cls: "easy-git-log-summary", text: summaryText });

    // Body — error detail or list of changed files
    if (entry.error) {
      const errBox = row.createDiv({ cls: "easy-git-log-error" });
      errBox.setText(entry.error);
    }
    if (entry.changedPaths && entry.changedPaths.length > 0) {
      const filesBox = row.createDiv({ cls: "easy-git-log-files" });
      filesBox.createEl("div", {
        cls: "easy-git-log-files-label",
        text: `Files (${entry.changedPaths.length}):`,
      });
      const ul = filesBox.createEl("ul");
      for (const path of entry.changedPaths.slice(0, 30)) {
        ul.createEl("li", { text: path });
      }
      if (entry.changedPaths.length > 30) {
        filesBox.createEl("div", {
          cls: "easy-git-log-files-more",
          text: `…and ${entry.changedPaths.length - 30} more`,
        });
      }
    }
    if (entry.conflicts > 0) {
      row.createDiv({
        cls: "easy-git-log-conflicts",
        text: `Conflicts shown: ${entry.conflicts}`,
      });
    }
  }

  private renderFooter(parent: HTMLElement): void {
    new Setting(parent)
      .addButton((b) =>
        b
          .setWarning()
          .setButtonText("Clear log")
          .onClick(async () => {
            await this.opts.onClear();
            this.close();
          }),
      )
      .addButton((b) =>
        b.setCta().setButtonText("Close").onClick(() => this.close()),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function formatRelative(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
