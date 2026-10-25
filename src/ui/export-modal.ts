import { App, Modal, Setting } from 'obsidian';
import { EXPORT_LABELS, type ExportFormat } from '../export';

/** Ask which format to export, and where to put it. */
export class ExportModal extends Modal {
  private format: ExportFormat = 'svg';
  private resolved = false;

  constructor(
    app: App,
    private folder: string,
    private onResult: (choice: { format: ExportFormat; folder: string } | null) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle('Export chart');
    contentEl.createEl('p', {
      cls: 'tng-confirm-summary',
      text: 'The export is saved into your vault, so it can be embedded in a note.'
    });

    new Setting(contentEl).setName('Format').addDropdown((dropdown) => {
      for (const [value, label] of Object.entries(EXPORT_LABELS) as [ExportFormat, string][]) {
        dropdown.addOption(value, label);
      }
      dropdown.setValue(this.format);
      dropdown.onChange((value) => {
        this.format = value as ExportFormat;
      });
    });

    new Setting(contentEl)
      .setName('Folder')
      .setDesc('Leave empty to save in the vault root.')
      .addText((text) =>
        text.setValue(this.folder).onChange((value) => {
          this.folder = value;
        })
      );

    new Setting(contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.finish(null)))
      .addButton((button) =>
        button
          .setButtonText('Export')
          .setCta()
          .onClick(() => this.finish({ format: this.format, folder: this.folder }))
      );
  }

  private finish(choice: { format: ExportFormat; folder: string } | null): void {
    if (this.resolved) return;
    this.resolved = true;
    this.onResult(choice);
    this.close();
  }

  onClose(): void {
    if (!this.resolved) {
      this.resolved = true;
      this.onResult(null);
    }
    this.contentEl.empty();
  }
}

export function chooseExport(
  app: App,
  folder: string
): Promise<{ format: ExportFormat; folder: string } | null> {
  return new Promise((resolve) => {
    new ExportModal(app, folder, resolve).open();
  });
}
