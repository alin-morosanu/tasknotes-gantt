import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBlockConfig } from '../src/settings/block-config';
import { CATALOG } from './fixtures/tasks';

/**
 * Every `tngantt` example in the documentation must be one the plugin accepts.
 *
 * An example that has drifted out of date is worse than none: someone copies it, gets
 * an error box, and concludes the feature is broken. This fails CI instead.
 */
const files = ['README.md', ...readdirSync('docs').map((f) => `docs/${f}`)].filter((f) =>
  f.endsWith('.md')
);

describe('tngantt examples in the docs', () => {
  const examples = files.flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/```tngantt\n([\s\S]*?)```/g)].map((m, i) => ({
      where: `${file} #${i + 1}`,
      body: m[1] ?? ''
    }))
  );

  it('exist', () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  it.each(examples.map((e) => [e.where, e.body] as const))('%s parses cleanly', (_where, body) => {
    // The fixture catalog defines `initiative` as a user field, as the reference vault does.
    expect(parseBlockConfig(body, CATALOG, 'assignee').errors).toEqual([]);
  });
});
