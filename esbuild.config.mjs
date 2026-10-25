import esbuild from 'esbuild';
import process from 'process';
import { builtinModules } from 'node:module';
import { deploy } from './scripts/deploy.mjs';

const production = process.argv[2] === 'production';

const deployPlugin = {
  name: 'deploy-to-vault',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      deploy({ quiet: true });
    });
  }
};

/**
 * The CLI is a separate bundle on purpose.
 *
 * It depends on `node:fs` and `yaml`, neither of which may enter the plugin bundle —
 * Obsidian's plugin runtime has no filesystem module, and pulling one in would break
 * the plugin at load. Keeping the entry points apart makes that structural rather
 * than a rule someone has to remember.
 */
const NODE_BANNER = [
  '#!/usr/bin/env node',
  "import { createRequire as __tngCreateRequire } from 'node:module';",
  'const require = __tngCreateRequire(import.meta.url);'
].join('\n');

async function buildNodeEntry(entry, outfile) {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    outfile,
    // `yaml` ships CommonJS, and esbuild's ESM output stubs `require` with a shim that
    // throws on builtins. Handing it a real `createRequire` lets a CJS dependency load
    // its own dependencies without forcing the whole entry to CommonJS.
    banner: { js: NODE_BANNER },
    external: [...builtinModules.map((m) => `node:${m}`), ...builtinModules],
    minify: production,
    sourcemap: production ? false : 'inline',
    logLevel: 'info'
  });
}

/** The two Node entries: the CLI, and the MCP server that wraps the same core. */
async function buildNodeEntries() {
  await buildNodeEntry('cli/main.ts', 'bin/tng.mjs');
  await buildNodeEntry('mcp/main.ts', 'bin/tng-mcp.mjs');
}

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', ...builtinModules],
  format: 'cjs',
  target: 'es2021',
  sourcemap: production ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  minify: production,
  logLevel: 'info',
  plugins: [deployPlugin]
});

if (production) {
  await context.rebuild();
  await context.dispose();
  await buildNodeEntries();
} else {
  await buildNodeEntries();
  await context.watch();
}
