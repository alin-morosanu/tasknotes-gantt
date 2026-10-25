import { Menu, setIcon, setTooltip } from 'obsidian';
import type { GanttTask } from '../types';
import {
  activeFacetCount,
  clearFacet,
  facetOptions,
  isFilterActive,
  toggleFacetValue,
  type FacetDefinition,
  type FilterState
} from '../model/filter';

/**
 * The filter row: a search box plus one menu per facet.
 *
 * Each menu is a plain Obsidian `Menu` of checkable items, which keeps the control
 * familiar and means a facet with forty projects in it scrolls the way every other
 * Obsidian menu does.
 */

export interface FilterBarHost {
  facets: () => readonly FacetDefinition[];
  /** All tasks before filtering, so counts reflect what selecting would give you. */
  allTasks: () => readonly GanttTask[];
  filter: () => FilterState;
  onChange: (next: FilterState) => void;
}

export class FilterBar {
  private rootEl: HTMLElement;
  private searchEl: HTMLInputElement;
  private facetsEl: HTMLElement;
  private clearEl: HTMLElement;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(containerEl: HTMLElement, private host: FilterBarHost) {
    this.rootEl = containerEl.createDiv({ cls: 'tng-filterbar' });

    const search = this.rootEl.createDiv({ cls: 'tng-filter-search' });
    setIcon(search.createSpan({ cls: 'tng-filter-search-icon' }), 'search');
    this.searchEl = search.createEl('input', {
      cls: 'tng-filter-input',
      attr: { type: 'text', placeholder: 'Filter tasks by name', 'aria-label': 'Filter tasks by name' }
    });
    this.searchEl.addEventListener('input', () => {
      // Debounced: retyping a project name should not rebuild the chart per keystroke.
      if (this.searchTimer !== null) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.searchTimer = null;
        this.host.onChange({ ...this.host.filter(), text: this.searchEl.value });
      }, 180);
    });

    this.facetsEl = this.rootEl.createDiv({ cls: 'tng-filter-facets' });

    this.clearEl = this.rootEl.createEl('button', { cls: 'tng-toolbar-button tng-filter-clear' });
    setIcon(this.clearEl, 'filter-x');
    setTooltip(this.clearEl, 'Clear all filters');
    this.clearEl.addEventListener('click', () => {
      this.searchEl.value = '';
      this.host.onChange({ text: '', facets: {} });
    });

    this.render();
  }

  /** Rebuild the facet buttons and their selected-state labels. */
  render(): void {
    const filter = this.host.filter();
    this.facetsEl.empty();

    for (const facet of this.host.facets()) {
      const selected = filter.facets[facet.id] ?? [];
      const button = this.facetsEl.createEl('button', { cls: 'tng-filter-facet' });
      button.toggleClass('is-active', selected.length > 0);

      button.createSpan({ cls: 'tng-filter-facet-label', text: facet.label });
      if (selected.length === 1) {
        // One value reads better named than counted.
        button.createSpan({
          cls: 'tng-filter-facet-value',
          text: facet.labelOf(selected[0] ?? '')
        });
      } else if (selected.length > 1) {
        button.createSpan({ cls: 'tng-filter-facet-value', text: String(selected.length) });
      }
      setIcon(button.createSpan({ cls: 'tng-filter-facet-caret' }), 'chevron-down');

      button.addEventListener('click', (event) => this.openFacetMenu(event, facet));
    }

    this.clearEl.toggleClass('is-active', isFilterActive(filter));
    this.clearEl.style.display = isFilterActive(filter) ? '' : 'none';
    const count = activeFacetCount(filter);
    setTooltip(
      this.clearEl,
      count === 0 ? 'Clear all filters' : `Clear all filters (${count} active)`
    );
  }

  private openFacetMenu(event: MouseEvent, facet: FacetDefinition): void {
    const filter = this.host.filter();
    const options = facetOptions(this.host.allTasks(), facet, filter, this.host.facets());
    const selected = filter.facets[facet.id] ?? [];

    const menu = new Menu();

    if (selected.length > 0) {
      menu.addItem((item) =>
        item
          .setTitle(`Clear ${facet.label.toLowerCase()}`)
          .setIcon('x')
          .onClick(() => this.host.onChange(clearFacet(filter, facet.id)))
      );
      menu.addSeparator();
    }

    if (options.length === 0) {
      menu.addItem((item) => item.setTitle('Nothing to filter by').setDisabled(true));
    }

    for (const option of options) {
      menu.addItem((item) =>
        item
          .setTitle(`${option.label} (${option.count})`)
          .setChecked(selected.includes(option.value))
          .onClick(() => {
            // Read the filter fresh: the menu may have been open across other changes.
            this.host.onChange(toggleFacetValue(this.host.filter(), facet.id, option.value));
          })
      );
    }

    menu.showAtMouseEvent(event);
  }

  /** Sync the search box when the filter is changed from elsewhere. */
  setFilter(filter: FilterState): void {
    if (this.searchEl.value !== filter.text) this.searchEl.value = filter.text;
    this.render();
  }

  dispose(): void {
    if (this.searchTimer !== null) clearTimeout(this.searchTimer);
    this.rootEl.remove();
  }
}
