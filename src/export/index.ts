import { Notice, normalizePath, TFile, type App } from 'obsidian';

/**
 * Saving an export into the vault.
 *
 * A file rather than a download: Obsidian's viewer blocks script-driven downloads in
 * several contexts, and an artifact that lands beside the notes it describes is more
 * useful anyway — an SVG or a Mermaid block can be embedded straight into a project
 * note.
 */

export type ExportFormat = 'svg' | 'png' | 'csv' | 'mermaid';

export const EXPORT_LABELS: Record<ExportFormat, string> = {
  svg: 'SVG image',
  png: 'PNG image',
  csv: 'CSV table',
  mermaid: 'Mermaid diagram'
};

export const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  svg: 'svg',
  png: 'png',
  csv: 'csv',
  mermaid: 'md'
};

/** A filename-safe stamp, so repeated exports do not overwrite each other. */
export function timestampSuffix(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(
    now.getHours()
  )}${p(now.getMinutes())}`;
}

/** Strip characters that are illegal or awkward in a vault path. */
export function sanitiseFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|#^[\]]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned === '' ? 'Gantt export' : cleaned.slice(0, 80);
}

export function exportPath(folder: string, baseName: string, format: ExportFormat): string {
  const file = `${sanitiseFileName(baseName)} ${timestampSuffix()}.${EXPORT_EXTENSIONS[format]}`;
  const trimmed = folder.trim().replace(/^\/+|\/+$/g, '');
  return normalizePath(trimmed === '' ? file : `${trimmed}/${file}`);
}

async function ensureFolder(app: App, path: string): Promise<void> {
  const parent = path.slice(0, path.lastIndexOf('/'));
  if (parent === '' || parent === path) return;
  if (app.vault.getFolderByPath(parent)) return;
  await app.vault.createFolder(parent);
}

/** Write a text export, then open it. */
export async function saveTextExport(
  app: App,
  path: string,
  contents: string
): Promise<TFile | null> {
  try {
    await ensureFolder(app, path);
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await app.vault.process(existing, () => contents);
      return existing;
    }
    const file = await app.vault.create(path, contents);
    return file;
  } catch (error) {
    new Notice(
      `TaskNotes Gantt: could not write ${path}. ${
        error instanceof Error ? error.message : String(error)
      }`,
      8000
    );
    return null;
  }
}

/** Write a binary export, then open it. */
export async function saveBinaryExport(
  app: App,
  path: string,
  data: ArrayBuffer
): Promise<TFile | null> {
  try {
    await ensureFolder(app, path);
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await app.vault.modifyBinary(existing, data);
      return existing;
    }
    return await app.vault.createBinary(path, data);
  } catch (error) {
    new Notice(
      `TaskNotes Gantt: could not write ${path}. ${
        error instanceof Error ? error.message : String(error)
      }`,
      8000
    );
    return null;
  }
}

/**
 * Rasterise an SVG string to PNG bytes.
 *
 * Goes through an Image and a canvas rather than a library. The SVG is inlined as a
 * data URL so nothing is fetched — an external reference would be blocked, and would
 * make the export depend on the network.
 */
export async function svgToPng(svg: string, scale = 2): Promise<ArrayBuffer | null> {
  const widthMatch = /width="(\d+(?:\.\d+)?)"/.exec(svg);
  const heightMatch = /height="(\d+(?:\.\d+)?)"/.exec(svg);
  const width = Number(widthMatch?.[1] ?? 0);
  const height = Number(heightMatch?.[1] ?? 0);
  if (width <= 0 || height <= 0) return null;

  // Very large charts exceed the browser's maximum canvas dimension and would come
  // back blank; step the scale down rather than produce an empty image.
  const maxSide = 8000;
  const safeScale = Math.min(scale, maxSide / Math.max(width, height));
  const canvasWidth = Math.max(1, Math.floor(width * safeScale));
  const canvasHeight = Math.max(1, Math.floor(height * safeScale));

  const encoded = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  const image = await new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = encoded;
  });
  if (!image) return null;

  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, canvasWidth, canvasHeight);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/png');
  });
  return blob ? await blob.arrayBuffer() : null;
}
