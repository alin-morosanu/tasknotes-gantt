/**
 * Minimal stand-in for the `obsidian` module.
 *
 * Only what the modules under test actually touch. Obsidian's real module exists only
 * inside the app, so unit tests alias it here (see vitest.config.ts) rather than
 * mocking it per test file.
 */

/** Notices raised during a test, so assertions can check what the user was told. */
export const notices: string[] = [];

export class Notice {
  constructor(public message: string) {
    notices.push(message);
  }
}

export function clearNotices(): void {
  notices.length = 0;
}

export class Modal {}

/** Obsidian collapses duplicate slashes and strips leading/trailing ones. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
}
export class Setting {}
export class PluginSettingTab {}
export class TFile {}
export function setIcon(): void {}
export function setTooltip(): void {}
