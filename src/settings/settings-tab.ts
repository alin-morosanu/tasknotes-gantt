import { App, PluginSettingTab, Setting } from 'obsidian';
import type TaskNotesGanttPlugin from '../main';
import { PROGRESS_LABELS, PROGRESS_SOURCES, type ProgressSource } from '../model/progress';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Parse `HH:MM`, returning null rather than a wrong number for bad input. */
function timeToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match?.[1] || !match[2]) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

export class GanttSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: TaskNotesGanttPlugin
  ) {
    super(app, plugin);
  }

  private async save(): Promise<void> {
    await this.plugin.saveSettings();
    this.plugin.refreshAllViews();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl)
      .setName('Safe mode')
      .setDesc(
        'Make the chart read-only. Dragging a bar will not change any note. Turn this on if you want to explore without risk.'
      )
      .addToggle((toggle) =>
        toggle.setValue(s.safeMode).onChange(async (value) => {
          s.safeMode = value;
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Confirm changes above')
      .setDesc(
        'Ask before applying a change that touches more than this many tasks. The dialog lists every edit.'
      )
      .addSlider((slider) =>
        slider
          .setLimits(1, 50, 1)
          .setValue(s.confirmThreshold)
          .setDynamicTooltip()
          .onChange(async (value) => {
            s.confirmThreshold = value;
            await this.save();
          })
      );

    new Setting(containerEl).setName('Working calendar').setHeading();

    new Setting(containerEl)
      .setName('Working days')
      .setDesc('Days that carry working hours. Estimates are spread across these only.');

    for (let day = 0; day < 7; day += 1) {
      new Setting(containerEl)
        .setName(DAY_NAMES[day] ?? String(day))
        .addToggle((toggle) =>
          toggle.setValue(s.workdays[day] === true).onChange(async (value) => {
            const next = [...s.workdays];
            next[day] = value;
            // Every day off would make duration arithmetic meaningless, so the last
            // one cannot be turned off.
            if (next.some(Boolean)) {
              s.workdays = next;
              await this.save();
            } else {
              toggle.setValue(true);
            }
          })
        )
        .settingEl.addClass('tng-setting-compact');
    }

    new Setting(containerEl)
      .setName('Working day')
      .setDesc('Start and end of the working day, as HH:MM. Used to turn estimates into spans.')
      .addText((text) =>
        text
          .setPlaceholder('09:00')
          .setValue(minutesToTime(s.dayStartMinutes))
          .onChange(async (value) => {
            const minutes = timeToMinutes(value);
            if (minutes === null || minutes >= s.dayEndMinutes) return;
            s.dayStartMinutes = minutes;
            await this.save();
          })
      )
      .addText((text) =>
        text
          .setPlaceholder('17:00')
          .setValue(minutesToTime(s.dayEndMinutes))
          .onChange(async (value) => {
            const minutes = timeToMinutes(value);
            if (minutes === null || minutes <= s.dayStartMinutes) return;
            s.dayEndMinutes = minutes;
            await this.save();
          })
      );

    new Setting(containerEl)
      .setName('Holidays')
      .setDesc('Non-working dates as YYYY-MM-DD, one per line.')
      .addTextArea((text) =>
        text.setValue(s.holidays.join('\n')).onChange(async (value) => {
          s.holidays = value
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => /^\d{4}-\d{2}-\d{2}$/.test(line));
          await this.save();
        })
      );

    new Setting(containerEl).setName('Dates and durations').setHeading();

    new Setting(containerEl)
      .setName('Due date is inclusive')
      .setDesc(
        'A task due on the 16th finishes at the end of the 16th. Turn this off if a due date means "by the start of that day".'
      )
      .addToggle((toggle) =>
        toggle.setValue(s.dueDateInclusive).onChange(async (value) => {
          s.dueDateInclusive = value;
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Default duration')
      .setDesc(
        'Span given to a task that has a date but no time estimate, in working minutes.'
      )
      .addText((text) =>
        text.setValue(String(s.defaultDurationMinutes)).onChange(async (value) => {
          const minutes = Number(value);
          if (!Number.isFinite(minutes) || minutes <= 0) return;
          s.defaultDurationMinutes = minutes;
          await this.save();
        })
      );

    new Setting(containerEl).setName('Dependencies').setHeading();

    new Setting(containerEl)
      .setName('Show dependency lines')
      .setDesc('Draw the connectors between tasks that depend on each other.')
      .addToggle((toggle) =>
        toggle.setValue(s.showDependencies).onChange(async (value) => {
          s.showDependencies = value;
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Show arrowheads')
      .setDesc(
        'Draw the head at the end of each connector. Turn this off if the heads add too much ink on a dense chart; the routing still shows which end is which.'
      )
      .addToggle((toggle) =>
        toggle.setValue(s.showArrowheads).onChange(async (value) => {
          s.showArrowheads = value;
          await this.save();
        })
      );

    new Setting(containerEl).setName('Scheduling').setHeading();

    new Setting(containerEl)
      .setName('Highlight the critical path')
      .setDesc(
        'Outline the chain of tasks that determines the project end date, and show a float column.'
      )
      .addToggle((toggle) =>
        toggle.setValue(s.showCriticalPath).onChange(async (value) => {
          s.showCriticalPath = value;
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Flag dependency conflicts')
      .setDesc('Mark tasks scheduled before something they depend on has finished.')
      .addToggle((toggle) =>
        toggle.setValue(s.showViolations).onChange(async (value) => {
          s.showViolations = value;
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Cascade dependents')
      .setDesc(
        'When you drag a bar, also push the tasks that depend on it. Successors are only ever moved later, never earlier.'
      )
      .addToggle((toggle) =>
        toggle.setValue(s.cascadeDependents).onChange(async (value) => {
          s.cascadeDependents = value;
          await this.save();
        })
      );

    new Setting(containerEl).setName('Appearance').setHeading();

    new Setting(containerEl)
      .setName('Row height')
      .addSlider((slider) =>
        slider
          .setLimits(18, 48, 2)
          .setValue(s.rowHeight)
          .setDynamicTooltip()
          .onChange(async (value) => {
            s.rowHeight = value;
            await this.save();
          })
      );

    new Setting(containerEl).setName('Baseline and progress').setHeading();

    new Setting(containerEl)
      .setName('Show baseline')
      .setDesc(
        'Draw a thin bar under each task showing where it was baselined, and a variance column.'
      )
      .addToggle((toggle) =>
        toggle.setValue(s.showBaseline).onChange(async (value) => {
          s.showBaseline = value;
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Baseline properties')
      .setDesc(
        'Frontmatter properties this plugin writes the baseline to. They are its own, not TaskNotes\u2019.'
      )
      .addText((text) =>
        text
          .setPlaceholder('ganttBaselineStart')
          .setValue(s.baselineStartField)
          .onChange(async (value) => {
            const name = value.trim();
            if (name === '') return;
            s.baselineStartField = name;
            await this.save();
          })
      )
      .addText((text) =>
        text
          .setPlaceholder('ganttBaselineEnd')
          .setValue(s.baselineEndField)
          .onChange(async (value) => {
            const name = value.trim();
            if (name === '') return;
            s.baselineEndField = name;
            await this.save();
          })
      );

    new Setting(containerEl)
      .setName('Progress source')
      .setDesc(
        'Which signal decides how far along a task is. The first that can answer wins; the rest are tried in order after it.'
      )
      .addDropdown((dropdown) => {
        for (const source of PROGRESS_SOURCES) {
          dropdown.addOption(source, PROGRESS_LABELS[source]);
        }
        dropdown.setValue(s.progressOrder[0] ?? 'status');
        dropdown.onChange(async (value) => {
          const first = value as ProgressSource;
          s.progressOrder = [first, ...PROGRESS_SOURCES.filter((v) => v !== first)];
          await this.save();
        });
      });

    new Setting(containerEl).setName('Capacity').setHeading();

    new Setting(containerEl)
      .setName('Show load histogram')
      .setDesc('Add a daily load bar chart beneath each group in the chart.')
      .addToggle((toggle) =>
        toggle.setValue(s.showCapacity).onChange(async (value) => {
          s.showCapacity = value;
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Capacity per day')
      .setDesc('Working minutes a resource can absorb in a day. 480 is an eight-hour day.')
      .addText((text) =>
        text.setValue(String(s.defaultCapacityMinutesPerDay)).onChange(async (value) => {
          const minutes = Number(value);
          if (!Number.isFinite(minutes) || minutes <= 0) return;
          s.defaultCapacityMinutesPerDay = minutes;
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Capacity overrides')
      .setDesc(
        'One per line, as "name = minutes". For example "Team = 1920" for four people.'
      )
      .addTextArea((text) =>
        text
          .setValue(
            Object.entries(s.capacityOverrides)
              .map(([key, value]) => `${key} = ${value}`)
              .join('\n')
          )
          .onChange(async (value) => {
            const overrides: Record<string, number> = {};
            for (const line of value.split('\n')) {
              const match = /^(.+?)\s*=\s*(\d+)\s*$/.exec(line.trim());
              if (!match?.[1] || !match[2]) continue;
              const minutes = Number(match[2]);
              if (minutes > 0) overrides[match[1].trim()] = minutes;
            }
            s.capacityOverrides = overrides;
            await this.save();
          })
      );

    new Setting(containerEl).setName('Export').setHeading();

    new Setting(containerEl)
      .setName('Export folder')
      .setDesc('Vault folder exports are saved to. Leave empty for the vault root.')
      .addText((text) =>
        text.setPlaceholder('Exports').setValue(s.exportFolder).onChange(async (value) => {
          s.exportFolder = value.trim();
          await this.save();
        })
      );

    new Setting(containerEl).setName('Grouping').setHeading();

    new Setting(containerEl)
      .setName('Resource property')
      .setDesc(
        'Frontmatter property the load chart, resource grouping and levelling measure ' +
          'against — whoever or whatever owes the work. `assignee` for people; ' +
          '`contexts`, `projects` or any property of your own also work.'
      )
      .addText((text) =>
        text.setValue(s.resourceField).onChange(async (value) => {
          s.resourceField = value.trim() || 'assignee';
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Show archived tasks')
      .addToggle((toggle) =>
        toggle.setValue(s.showArchived).onChange(async (value) => {
          s.showArchived = value;
          await this.save();
        })
      );
  }
}
