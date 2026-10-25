import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // `obsidian` only exists inside the app; unit tests get a minimal stand-in.
      obsidian: fileURLToPath(new URL('./tests/stubs/obsidian.ts', import.meta.url))
    }
  }
});
