import { App, Modal, Setting } from 'obsidian';

/**
 * Confirmation for a change that touches many notes at once.
 *
 * It lists the actual edits rather than a count, because "this will modify 34 tasks"
 * is not enough information to approve or reject — the user needs to see whether the
 * right tasks are moving, and by how much.
 */
export class ConfirmChangesModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private label: string,
    private descriptions: string[],
    private onResult: (approved: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('tng-confirm');

    this.setTitle(this.label);
    contentEl.createEl('p', {
      cls: 'tng-confirm-summary',
      text: `This will change ${this.descriptions.length} task${
        this.descriptions.length === 1 ? '' : 's'
      } in your vault.`
    });

    const list = contentEl.createDiv({ cls: 'tng-confirm-list' });
    // Cap the rendered list: a thousand rows of DOM would stall the dialog, and past
    // a point the user is approving the shape of the change, not each line.
    const shown = this.descriptions.slice(0, 100);
    for (const description of shown) {
      list.createDiv({ cls: 'tng-confirm-item', text: description });
    }
    if (this.descriptions.length > shown.length) {
      list.createDiv({
        cls: 'tng-confirm-item tng-confirm-more',
        text: `…and ${this.descriptions.length - shown.length} more`
      });
    }

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText('Cancel').onClick(() => {
          this.finish(false);
        })
      )
      .addButton((button) =>
        button
          .setButtonText('Apply changes')
          .setCta()
          .onClick(() => {
            this.finish(true);
          })
      );
  }

  private finish(approved: boolean): void {
    if (this.resolved) return;
    this.resolved = true;
    this.onResult(approved);
    this.close();
  }

  onClose(): void {
    // Dismissing the dialog any other way (Escape, clicking out) must not be read as
    // approval to rewrite the user's notes.
    if (!this.resolved) {
      this.resolved = true;
      this.onResult(false);
    }
    this.contentEl.empty();
  }
}

export function confirmChanges(
  app: App,
  label: string,
  descriptions: string[]
): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmChangesModal(app, label, descriptions, resolve).open();
  });
}
