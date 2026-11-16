import { NotificationLevel, PluginSettings } from "./types";

type NotificationSettings = Pick<PluginSettings, "notificationLevel" | "showNotifications">;

/**
 * The effective notification level. Settings saved before levels existed
 * carry only the `showNotifications` boolean: false maps to "off",
 * anything else to "all", so no existing user's notices change on upgrade.
 */
export function notificationLevel(s: NotificationSettings): NotificationLevel {
  const level = s.notificationLevel;
  if (level === "all" || level === "errors" || level === "off") return level;
  return s.showNotifications === false ? "off" : "all";
}

/** Informational notices: sync summaries, rewrites, backups, renames. */
export function notifyInfo(s: NotificationSettings): boolean {
  return notificationLevel(s) === "all";
}

/**
 * Decides which failed syncs get a notice.
 *
 * "All" shows every failure, as before. "Errors only" shows every failure
 * of an explicit sync (button, command), but each distinct failure of an
 * automatic one (interval, on save, startup) once per session. Without
 * that, an expired token would raise a notice after every save while the
 * user types. A success clears the memory, so the next failure is
 * announced again. In-memory on purpose: after a restart the first
 * failure is announced again too.
 */
export class FailureNotifier {
  private announced = new Map<string, string>();

  /** Call for every sync result: a success (no error) resets the
   * destination. Returns true when the failure should show a notice. */
  shouldNotify(
    level: NotificationLevel,
    destinationId: string,
    error: string | undefined,
    explicit: boolean,
  ): boolean {
    if (!error) {
      this.announced.delete(destinationId);
      return false;
    }
    if (level === "off") return false;
    const repeat = this.announced.get(destinationId) === error;
    this.announced.set(destinationId, error);
    return level === "all" || explicit || !repeat;
  }
}
