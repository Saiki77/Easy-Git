import { App, Modal, Notice, Setting } from "obsidian";
import {
  DeviceCodeResponse,
  pollDeviceToken,
  startDeviceFlow,
} from "../github/auth";

export interface DeviceFlowResult {
  token: string;
  scope?: string;
}

export interface DeviceFlowModalOpts {
  onSuccess: (result: DeviceFlowResult) => Promise<void> | void;
  onCancel?: () => void;
}

export class DeviceFlowModal extends Modal {
  private opts: DeviceFlowModalOpts;
  private cancelled = false;
  private codeResponse: DeviceCodeResponse | null = null;
  private statusEl?: HTMLDivElement;

  constructor(app: App, opts: DeviceFlowModalOpts) {
    super(app);
    this.opts = opts;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Sign in with GitHub" });
    this.statusEl = contentEl.createDiv({
      cls: "easy-git-device-status",
      text: "Requesting device code…",
    });
    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("Cancel").onClick(() => {
          this.cancelled = true;
          this.close();
        }),
      );

    void this.startFlow();
  }

  onClose(): void {
    this.cancelled = true;
    this.opts.onCancel?.();
    this.contentEl.empty();
  }

  private async startFlow(): Promise<void> {
    let resp: DeviceCodeResponse;
    try {
      resp = await startDeviceFlow();
    } catch (e) {
      this.setStatus(
        "Failed to start Device Flow: " +
          (e instanceof Error ? e.message : String(e)),
        true,
      );
      return;
    }
    if (this.cancelled) return;
    this.codeResponse = resp;
    this.renderCode(resp);
    void this.poll(resp);
  }

  private renderCode(resp: DeviceCodeResponse): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Sign in with GitHub" });
    contentEl.createEl("p", {
      text: "Open the link below in your browser and enter the code:",
    });
    const codeEl = contentEl.createDiv({ cls: "easy-git-device-code", text: resp.user_code });
    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText("Copy code")
          .onClick(() => {
            navigator.clipboard.writeText(resp.user_code);
            new Notice("Code copied to clipboard.");
          }),
      )
      .addButton((b) =>
        b
          .setCta()
          .setButtonText("Open browser")
          .onClick(() => {
            window.open(resp.verification_uri, "_blank");
          }),
      );
    contentEl.createEl("p", {
      text: `Or visit ${resp.verification_uri} manually.`,
      attr: { style: "font-size: 0.85em; color: var(--text-muted);" },
    });
    this.statusEl = contentEl.createDiv({
      cls: "easy-git-device-status",
      text: "Waiting for authorization…",
    });
    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Cancel").onClick(() => {
        this.cancelled = true;
        this.close();
      }),
    );
    void this.attachKeepalive(codeEl);
  }

  private async attachKeepalive(_codeEl: HTMLElement): Promise<void> {
    // No-op placeholder; left in case we want subtle UI hints later.
  }

  private async poll(resp: DeviceCodeResponse): Promise<void> {
    const startedAt = Date.now();
    let intervalMs = (resp.interval ?? 5) * 1000;
    while (!this.cancelled) {
      if (Date.now() - startedAt > resp.expires_in * 1000) {
        this.setStatus("Code expired. Please reopen Sign in.", true);
        return;
      }
      await delay(intervalMs);
      if (this.cancelled) return;
      let tokenResp;
      try {
        tokenResp = await pollDeviceToken(resp.device_code);
      } catch (e) {
        this.setStatus(
          "Network error while polling: " +
            (e instanceof Error ? e.message : String(e)),
          true,
        );
        return;
      }
      if (tokenResp.access_token) {
        await this.opts.onSuccess({
          token: tokenResp.access_token,
          scope: tokenResp.scope,
        });
        this.cancelled = true;
        this.close();
        return;
      }
      if (tokenResp.error === "authorization_pending") {
        continue;
      }
      if (tokenResp.error === "slow_down") {
        intervalMs += 5000;
        continue;
      }
      if (tokenResp.error === "expired_token") {
        this.setStatus("Code expired. Please reopen Sign in.", true);
        return;
      }
      if (tokenResp.error === "access_denied") {
        this.setStatus("Access denied. Sign-in cancelled.", true);
        return;
      }
      if (tokenResp.error) {
        this.setStatus(
          "Sign-in failed: " + (tokenResp.error_description ?? tokenResp.error),
          true,
        );
        return;
      }
    }
  }

  private setStatus(text: string, error = false): void {
    if (!this.statusEl) return;
    this.statusEl.setText(text);
    this.statusEl.toggleClass("is-error", error);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
