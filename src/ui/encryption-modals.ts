import { App, Modal, Notice, Setting } from "obsidian";

/**
 * The two encryption dialogs: first-device setup (choose a passphrase, save
 * the recovery key) and any-device unlock (passphrase or recovery key).
 * Both stay open on failure so a typo costs one retry, not a whole flow.
 * The async work (PBKDF2 at ~600k iterations) takes about a second, so the
 * action buttons show a busy label while it runs.
 */

export interface EncryptionSetupOptions {
  destinationLabel: string;
  /** True when the destination already has synced files, which means the
   * repo's git history keeps their plaintext versions after migration. */
  hasRemoteHistory: boolean;
  /** Generate and persist the key material. Returns the recovery key
   * (base64 master key) for the second screen. Throws to keep the form
   * open with a Notice. */
  onProvision: (passphrase: string) => Promise<string>;
  /** Called once, after the recovery-key screen is dismissed. */
  onDone: () => void;
}

const MIN_PASSPHRASE_LENGTH = 8;

export class EncryptionSetupModal extends Modal {
  private provisioned = false;

  constructor(
    app: App,
    private opts: EncryptionSetupOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    this.renderForm();
  }

  private renderForm(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Set Up End-to-End Encryption" });
    contentEl.createEl("p", { text: `Destination: ${this.opts.destinationLabel}` });
    contentEl.createEl("p", {
      text:
        "Content is encrypted on this device before upload; the repo host only ever " +
        "sees ciphertext. The same passphrase unlocks this destination on your other " +
        "devices. It is never stored or sent anywhere. If you lose both the " +
        "passphrase and the recovery key, the remote copy is unreadable forever.",
    });
    contentEl.createEl("p", {
      text:
        "File and folder names stay visible on the remote; file contents do not.",
    });
    if (this.opts.hasRemoteHistory) {
      contentEl.createEl("p", {
        text:
          "This destination already has synced files. The next sync re-uploads " +
          "everything encrypted, but earlier plaintext versions remain in the repo's " +
          "git history. For a fully clean start, point the destination at a fresh " +
          "repo or branch instead. If other devices pushed recently, sync once " +
          "before enabling.",
      });
    }

    let passphrase = "";
    let confirmation = "";
    new Setting(contentEl).setName("Passphrase").addText((t) => {
      t.inputEl.type = "password";
      t.setPlaceholder(`At least ${MIN_PASSPHRASE_LENGTH} characters`);
      t.onChange((v) => (passphrase = v));
    });
    new Setting(contentEl).setName("Repeat passphrase").addText((t) => {
      t.inputEl.type = "password";
      t.onChange((v) => (confirmation = v));
    });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => {
        b.setCta()
          .setButtonText("Enable Encryption")
          .onClick(async () => {
            if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
              new Notice(
                `Easy Git: the passphrase needs at least ${MIN_PASSPHRASE_LENGTH} characters.`,
              );
              return;
            }
            if (passphrase !== confirmation) {
              new Notice("Easy Git: the two passphrase entries do not match.");
              return;
            }
            b.setDisabled(true).setButtonText("Deriving key…");
            try {
              const recoveryKey = await this.opts.onProvision(passphrase);
              this.renderRecoveryKey(recoveryKey);
            } catch (e) {
              new Notice(
                `Easy Git: could not enable encryption: ${e instanceof Error ? e.message : String(e)}`,
                8000,
              );
              b.setDisabled(false).setButtonText("Enable Encryption");
            }
          });
      });
  }

  private renderRecoveryKey(recoveryKey: string): void {
    this.provisioned = true;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Save Your Recovery Key" });
    contentEl.createEl("p", {
      text:
        "This key unlocks the destination if the passphrase is ever lost. Store it " +
        "somewhere safe OUTSIDE this vault, in a password manager or a printout. It is " +
        "shown only this once.",
    });
    const box = contentEl.createEl("textarea", {
      text: recoveryKey,
      cls: "easy-git-secret-box",
    });
    box.readOnly = true;
    box.rows = 2;
    box.addEventListener("focus", () => box.select());

    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("Copy").onClick(async () => {
          await navigator.clipboard.writeText(recoveryKey);
          new Notice("Easy Git: recovery key copied.");
        }),
      )
      .addButton((b) =>
        b
          .setCta()
          .setButtonText("I Stored It, Encrypt Now")
          .onClick(() => this.close()),
      );
  }

  onClose(): void {
    this.contentEl.empty();
    // Fires on the X button too: once the key exists, the migration sync
    // should run either way.
    if (this.provisioned) this.opts.onDone();
  }
}

export interface EncryptionUnlockOptions {
  destinationLabel: string;
  /** Verify the secret and persist the key. Throws (with a user-showable
   * message) to keep the dialog open. */
  onUnlock: (secret: string, useRecoveryKey: boolean) => Promise<void>;
  /** Called once after a successful unlock. */
  onDone: () => void;
}

export class EncryptionUnlockModal extends Modal {
  private useRecoveryKey = false;
  private secret = "";
  private unlocked = false;

  constructor(
    app: App,
    private opts: EncryptionUnlockOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Unlock Encrypted Destination" });
    contentEl.createEl("p", { text: `Destination: ${this.opts.destinationLabel}` });
    contentEl.createEl("p", {
      text: this.useRecoveryKey
        ? "Paste the recovery key that was shown when encryption was set up."
        : "Enter the passphrase chosen when encryption was set up for this destination.",
    });

    if (this.useRecoveryKey) {
      const box = contentEl.createEl("textarea", { cls: "easy-git-secret-box" });
      box.rows = 2;
      box.value = this.secret;
      box.addEventListener("input", () => (this.secret = box.value));
    } else {
      new Setting(contentEl).setName("Passphrase").addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.secret);
        t.onChange((v) => (this.secret = v));
      });
    }

    new Setting(contentEl)
      .setName("Use recovery key instead")
      .addToggle((t) =>
        t.setValue(this.useRecoveryKey).onChange((v) => {
          this.useRecoveryKey = v;
          this.secret = "";
          this.render();
        }),
      );

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => {
        b.setCta()
          .setButtonText("Unlock")
          .onClick(async () => {
            if (!this.secret) return;
            b.setDisabled(true).setButtonText("Unlocking…");
            try {
              await this.opts.onUnlock(this.secret, this.useRecoveryKey);
              this.unlocked = true;
              this.close();
            } catch (e) {
              new Notice(
                `Easy Git: ${e instanceof Error ? e.message : String(e)}`,
                8000,
              );
              b.setDisabled(false).setButtonText("Unlock");
            }
          });
      });
  }

  onClose(): void {
    this.contentEl.empty();
    if (this.unlocked) this.opts.onDone();
  }
}
