import { ButtonComponent } from "obsidian";

/**
 * Mark a button as destructive in a way that works across the Obsidian
 * versions we support (minAppVersion 1.6.6+).
 *
 * `setDestructive()` was added in Obsidian 1.13.0; `setWarning()` is the
 * older equivalent and is deprecated from 1.13.0 onward. We can't call
 * either unconditionally: `setDestructive` doesn't exist before 1.13.0,
 * and referencing the deprecated `setWarning` symbol directly trips the
 * plugin linter. So we resolve both through a structural cast (which
 * carries no `@deprecated` tag) and pick whichever exists at runtime.
 *
 * Returns the same button so it can stay in a fluent chain.
 */
export function markButtonDestructive(button: ButtonComponent): ButtonComponent {
  const compat = button as unknown as {
    setDestructive?: () => unknown;
    setWarning?: () => unknown;
  };
  if (typeof compat.setDestructive === "function") {
    compat.setDestructive();
  } else if (typeof compat.setWarning === "function") {
    compat.setWarning();
  }
  return button;
}
