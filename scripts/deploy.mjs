import fs from 'node:fs';
import path from 'node:path';
import process from 'process';

const ARTIFACTS = ['main.js', 'manifest.json', 'styles.css'];

/**
 * Copy the built plugin into a vault's plugin folder.
 * Target vault comes from OBSIDIAN_VAULT; deploying is a no-op when it is unset,
 * so a plain `npm run dev` never touches anyone's vault by accident.
 */
export function deploy({ quiet = false } = {}) {
  const vault = process.env.OBSIDIAN_VAULT;
  if (!vault) {
    if (!quiet) console.log('OBSIDIAN_VAULT is not set — skipping deploy.');
    return false;
  }
  if (!fs.existsSync(path.join(vault, '.obsidian'))) {
    console.warn(`OBSIDIAN_VAULT does not look like a vault (no .obsidian): ${vault}`);
    return false;
  }
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  const target = path.join(vault, '.obsidian', 'plugins', manifest.id);
  fs.mkdirSync(target, { recursive: true });
  for (const file of ARTIFACTS) {
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(target, file));
  }
  // Obsidian's Hot Reload plugin watches for this marker.
  fs.writeFileSync(path.join(target, '.hotreload'), '');
  console.log(`Deployed ${manifest.id} -> ${target}`);
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) deploy();
