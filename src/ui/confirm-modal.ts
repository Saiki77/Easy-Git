import { App, Modal, Setting } from "obsidian";

export interface ConfirmModalOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
}

export class ConfirmModal extends Modal {
  private opts: ConfirmModalOptions;

  constructor(app: App, opts: ConfirmModalOptions) {
    super(app);
    this.opts = opts;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.opts.title });
    contentEl.createEl("p", { text: this.opts.message });

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText(this.opts.cancelText ?? "Cancel")
          .onClick(() => this.close()),
      )
      .addButton((b) => {
        b.setButtonText(this.opts.confirmText ?? "Confirm").onClick(async () => {
          this.close();
          await this.opts.onConfirm();
        });
        if (this.opts.destructive) b.setWarning();
        else b.setCta();
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
