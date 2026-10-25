/**
 * Reads the active Obsidian theme's colors so the canvas matches the surrounding UI.
 *
 * Canvas cannot use CSS variables, so the values are resolved once per render into
 * concrete colors. Resolving from the container element rather than `document.body`
 * means community themes and per-pane overrides are picked up correctly.
 */

export interface Palette {
  text: string;
  textMuted: string;
  textFaint: string;
  background: string;
  backgroundAlt: string;
  border: string;
  borderHover: string;
  accent: string;
  /** Shading for weekends and other non-working time. */
  nonWorking: string;
  /** The "today" marker. */
  today: string;
  gridLine: string;
  gridLineStrong: string;
  barText: string;
  error: string;
  /** The critical path. Distinct from `error`: being critical is not a fault. */
  critical: string;
}

const FALLBACK: Palette = {
  text: '#222222',
  textMuted: '#666666',
  textFaint: '#999999',
  background: '#ffffff',
  backgroundAlt: '#f5f5f5',
  border: '#dddddd',
  borderHover: '#bbbbbb',
  accent: '#5b6ee1',
  nonWorking: 'rgba(0, 0, 0, 0.04)',
  today: '#e5534b',
  gridLine: 'rgba(0, 0, 0, 0.06)',
  gridLineStrong: 'rgba(0, 0, 0, 0.14)',
  barText: '#ffffff',
  error: '#e5534b',
  critical: '#d9822b'
};

function readVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = styles.getPropertyValue(name).trim();
  return value === '' ? fallback : value;
}

export function readPalette(el: HTMLElement): Palette {
  // getComputedStyle can throw on a detached element (during teardown, or in a
  // thumbnail capture), and a chart that fails to paint is worse than one in
  // fallback colors.
  let styles: CSSStyleDeclaration;
  try {
    styles = getComputedStyle(el);
  } catch {
    return FALLBACK;
  }

  return {
    text: readVar(styles, '--text-normal', FALLBACK.text),
    textMuted: readVar(styles, '--text-muted', FALLBACK.textMuted),
    textFaint: readVar(styles, '--text-faint', FALLBACK.textFaint),
    background: readVar(styles, '--background-primary', FALLBACK.background),
    backgroundAlt: readVar(styles, '--background-secondary', FALLBACK.backgroundAlt),
    border: readVar(styles, '--background-modifier-border', FALLBACK.border),
    borderHover: readVar(styles, '--background-modifier-border-hover', FALLBACK.borderHover),
    accent: readVar(styles, '--interactive-accent', FALLBACK.accent),
    nonWorking: readVar(styles, '--background-modifier-hover', FALLBACK.nonWorking),
    today: readVar(styles, '--text-error', FALLBACK.today),
    gridLine: readVar(styles, '--background-modifier-border', FALLBACK.gridLine),
    gridLineStrong: readVar(styles, '--background-modifier-border-hover', FALLBACK.gridLineStrong),
    barText: readVar(styles, '--text-on-accent', FALLBACK.barText),
    error: readVar(styles, '--text-error', FALLBACK.error),
    critical: readVar(styles, '--color-orange', FALLBACK.critical)
  };
}

/**
 * Add an alpha channel to a color that may be hex, rgb() or hsl().
 *
 * Theme variables come in all three forms, and `color-mix` is not available in a
 * canvas context, so this normalizes them.
 */
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim();

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (hex?.[1]) {
    const digits = hex[1];
    const full =
      digits.length === 3
        ? digits
            .split('')
            .map((d) => d + d)
            .join('')
        : digits;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  const fn = /^(rgba?|hsla?)\(([^)]+)\)$/i.exec(c);
  if (fn?.[1] && fn[2]) {
    const name = fn[1].toLowerCase().replace(/a$/, '');
    // Both comma and space separated forms occur; drop any existing alpha component.
    const parts = fn[2].split(/[,/]/).map((p) => p.trim()).filter((p) => p !== '');
    const components = parts.slice(0, 3).join(', ');
    return `${name}a(${components}, ${alpha})`;
  }

  return c;
}

/** Status colors come from the user's TaskNotes catalog, so bars match their kanban. */
export function statusColor(
  value: string,
  statuses: readonly { value: string; color: string }[],
  fallback: string
): string {
  return statuses.find((s) => s.value === value)?.color ?? fallback;
}
