import { Plugin } from "obsidian";

export interface StatusState {
  hasMappings: boolean;
  anySyncing: boolean;
  anyErrored: boolean;
  /** Epoch ms of the most recent successful sync across all mappings. */
  mostRecentSync?: number;
}

/**
 * Single Obsidian status-bar element showing the aggregate health of all
 * mappings. Clicks to open the Easy Git settings tab. Refresh on demand
 * (call refresh() after any sync state change) and ticks every 30 s so the
 * relative-time string stays current without explicit nudges.
 */
export class StatusBarIndicator {
  private el: HTMLElement;
  private getState: () => StatusState;
  private openSettings: () => void;

  constructor(
    parent: HTMLElement,
    getState: () => StatusState,
    openSettings: () => void,
  ) {
    this.el = parent;
    this.el.addClass("easy-git-status-bar");
    this.getState = getState;
    this.openSettings = openSettings;
    this.el.style.cursor = "pointer";
    this.el.addEventListener("click", () => this.openSettings());
    this.refresh();
  }

  startTicker(plugin: Plugin): void {
    const handle = window.setInterval(() => this.refresh(), 30_000);
    plugin.registerInterval(handle);
  }

  refresh(): void {
    const state = this.getState();
    this.el.removeClass("is-syncing", "is-error", "is-ok", "is-hidden");
    this.el.empty();

    if (!state.hasMappings) {
      this.el.addClass("is-hidden");
      this.el.style.display = "none";
      return;
    }
    this.el.style.display = "";

    if (state.anySyncing) {
      this.el.addClass("is-syncing");
      this.el.setText("↻ Syncing…");
      return;
    }
    if (state.anyErrored) {
      this.el.addClass("is-error");
      this.el.setText("! Easy Git error");
      return;
    }
    this.el.addClass("is-ok");
    if (state.mostRecentSync) {
      this.el.setText(`↻ Synced ${formatRelative(state.mostRecentSync)}`);
    } else {
      this.el.setText("↻ Ready");
    }
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
