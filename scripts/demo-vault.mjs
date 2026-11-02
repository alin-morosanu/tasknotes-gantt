import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/**
 * Build a demo vault of made-up projects, for screenshots and trying the plugin out.
 *
 *   node scripts/demo-vault.mjs <target-folder>
 *
 * Everything in it is fictional: a website relaunch, a help centre and an office move,
 * worked on by Avery, Blake, Casey and Drew. Screenshots for the README come from here
 * and never from a real vault, which would publish real people's names and plans.
 *
 * Dates are computed from the day the script runs, so the plan always straddles today
 * and the screenshots can be regenerated for any release without looking stale. The
 * TaskNotes plugin itself is copied from an existing vault (`TASKNOTES_FROM`), but its
 * settings are written here from scratch: a real data.json carries API and calendar
 * tokens that have no business being copied anywhere.
 */

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/demo-vault.mjs <target-folder>');
  process.exit(2);
}
const TASKNOTES_FROM = process.env.TASKNOTES_FROM;

// --- dates: whole working days relative to this week's Monday -----------------------
const monday = (() => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
})();
/** The date `n` working days from this Monday (negative goes back). */
function workday(n) {
  const d = new Date(monday);
  let left = Math.abs(n);
  const step = n < 0 ? -1 : 1;
  while (left > 0) {
    d.setDate(d.getDate() + step);
    if (d.getDay() !== 0 && d.getDay() !== 6) left -= 1;
  }
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// --- the plan -------------------------------------------------------------------------
// [id, title, project, initiative, assignee, status, priority, start, end, estimate
//  minutes, blockedBy[], checklist [done, total]]
const P1 = 'PRJ-01 Website Relaunch';
const P2 = 'PRJ-02 Help Centre';
const P3 = 'PRJ-03 Office Move';
const GROWTH = 'Company Growth';
const OPS = 'Operations';

const TASKS = [
  ['WEB-01', 'Audit the current site', P1, GROWTH, 'Avery', 'done', 'normal', -15, -13, 960, [], [6, 6]],
  ['WEB-02', 'Draft the sitemap', P1, GROWTH, 'Blake', 'done', 'normal', -12, -10, 720, ['WEB-01'], [4, 4]],
  ['WEB-03', 'Write homepage copy', P1, GROWTH, 'Avery', 'in-progress', 'high', -6, 1, 1440, ['WEB-02'], [3, 5]],
  ['WEB-04', 'Design page templates', P1, GROWTH, 'Casey', 'in-progress', 'high', -7, 2, 1920, ['WEB-02'], [2, 6]],
  ['WEB-05', 'Build templates in the CMS', P1, GROWTH, 'Drew', 'up-next', 'high', 3, 9, 2400, ['WEB-04'], [0, 4]],
  ['WEB-06', 'Migrate existing content', P1, GROWTH, 'Blake', 'backlog', 'normal', 10, 15, 1920, ['WEB-05', 'WEB-03'], [0, 3]],
  ['WEB-07', 'Accessibility and QA pass', P1, GROWTH, 'Casey', 'backlog', 'high', 16, 19, 1440, ['WEB-06'], [0, 8]],
  ['WEB-08', 'Launch the new site', P1, GROWTH, 'Avery', 'backlog', 'high', 20, 20, 0, ['WEB-07'], null],
  ['DOC-01', 'Inventory existing docs', P2, GROWTH, 'Blake', 'done', 'low', -10, -8, 600, [], [5, 5]],
  ['DOC-02', 'Choose a help-centre tool', P2, GROWTH, 'Drew', 'in-progress', 'normal', -2, 1, 480, ['DOC-01'], [1, 3]],
  ['DOC-03', 'Write the getting-started guide', P2, GROWTH, 'Avery', 'backlog', 'normal', 2, 7, 1440, ['DOC-02'], [0, 4]],
  ['DOC-04', 'Write the FAQ', P2, GROWTH, 'Blake', 'backlog', 'low', 4, 8, 960, ['DOC-02'], [0, 2]],
  ['DOC-05', 'Import articles into the help centre', P2, GROWTH, 'Drew', 'backlog', 'normal', 10, 12, 720, ['DOC-03', 'WEB-05'], [0, 2]],
  ['DOC-06', 'Link the help centre from the new site', P2, GROWTH, 'Casey', 'backlog', 'normal', 21, 21, 240, ['WEB-08'], null],
  ['OFF-01', 'Shortlist office spaces', P3, OPS, 'Drew', 'done', 'normal', -14, -11, 720, [], [4, 4]],
  ['OFF-02', 'Negotiate and sign the lease', P3, OPS, 'Avery', 'in-progress', 'high', -4, 3, 600, ['OFF-01'], [2, 3]],
  ['OFF-03', 'Plan the floor layout', P3, OPS, 'Casey', 'backlog', 'normal', 4, 8, 960, ['OFF-02'], [0, 3]],
  ['OFF-04', 'Order furniture', P3, OPS, 'Blake', 'backlog', 'normal', 9, 10, 480, ['OFF-03'], [0, 2]],
  ['OFF-05', 'Book the movers', P3, OPS, 'Drew', 'backlog', 'low', 9, 9, 120, ['OFF-03'], null],
  ['OFF-06', 'Move day', P3, OPS, 'Avery', 'backlog', 'high', 22, 22, 0, ['OFF-04', 'OFF-05'], null]
];

const title = (id) => TASKS.find((t) => t[0] === id)?.[1] ?? id;
const file = (id) => `${id} ${title(id)}`;

function taskNote([, name, project, initiative, assignee, status, priority, start, end, estimate, blockedBy, checklist]) {
  const fm = [
    '---',
    `status: ${status}`,
    `priority: ${priority}`,
    `scheduled: ${workday(start)}`,
    `due: ${workday(end)}`,
    'tags:',
    '  - task',
    'contexts:',
    '  - work',
    'projects:',
    `  - "[[${project}]]"`,
    `initiative: ${initiative}`,
    `assignee: ${assignee}`,
    `timeEstimate: ${estimate}`
  ];
  if (blockedBy.length > 0) {
    fm.push('blockedBy:');
    for (const dep of blockedBy) fm.push(`  - uid: "[[${file(dep)}]]"`, '    reltype: FINISHTOSTART');
  }
  fm.push('---', '', `## ${name}`, '');
  if (checklist) {
    const [done, total] = checklist;
    for (let i = 0; i < total; i += 1) fm.push(`- [${i < done ? 'x' : ' '}] Step ${i + 1}`);
  }
  return `${fm.join('\n')}\n`;
}

function projectNote(blurb, block) {
  return `${blurb}\n\n## Timeline\n\n\`\`\`tngantt\n${block}\n\`\`\`\n`;
}

// --- write it -------------------------------------------------------------------------
const root = path.resolve(target);
if (fs.existsSync(root) && fs.readdirSync(root).length > 0 && !fs.existsSync(path.join(root, '.demo-vault'))) {
  console.error(`Refusing to write into ${root}: it exists, is not empty, and is not a demo vault.`);
  process.exit(1);
}
const write = (rel, text) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

fs.rmSync(path.join(root, 'TaskNotes'), { recursive: true, force: true });
write('.demo-vault', 'Generated by scripts/demo-vault.mjs. Safe to delete.\n');
for (const t of TASKS) write(`TaskNotes/Tasks/${file(t[0])}.md`, taskNote(t));

write(`TaskNotes/Projects/${P1}.md`, projectNote(
  'Replace the old marketing site with one the team can update without a developer.',
  'project: Website Relaunch\nzoom: week\ngroupBy: none\ncritical: true\nheight: 280'));
write(`TaskNotes/Projects/${P2}.md`, projectNote(
  'A searchable help centre, live in time for the new site.',
  'project: Help Centre\ngroupBy: none\nheight: 260'));
write(`TaskNotes/Projects/${P3}.md`, projectNote(
  'Move the team into the new office without losing a working week.',
  'project: Office Move\ngroupBy: none\nheight: 260'));
write('Company Growth.md', projectNote(
  'Every project under the Company Growth initiative, on one timeline.',
  'initiative: Company Growth\nzoom: week\nheight: 420\ncritical: true'));

// TaskNotes settings, written from scratch.
const tasknotes = {
  taskTag: 'task',
  taskIdentificationMethod: 'tag',
  tasksFolder: 'TaskNotes/Tasks',
  enableAPI: false,
  customStatuses: [
    { id: 'backlog', value: 'backlog', label: 'Backlog', color: '#808080', isCompleted: false, order: 0 },
    { id: 'up-next', value: 'up-next', label: 'Up next', color: '#6366f1', isCompleted: false, order: 1 },
    { id: 'in-progress', value: 'in-progress', label: 'In progress', color: '#0066cc', isCompleted: false, order: 2 },
    { id: 'done', value: 'done', label: 'Done', color: '#16a34a', isCompleted: true, order: 3 }
  ],
  customPriorities: [
    { id: 'low', value: 'low', label: 'Low', color: '#16a34a', weight: 1 },
    { id: 'normal', value: 'normal', label: 'Normal', color: '#f59e0b', weight: 2 },
    { id: 'high', value: 'high', label: 'High', color: '#dc2626', weight: 3 }
  ],
  userFields: [{ id: 'field_initiative', displayName: 'Initiative', key: 'initiative', type: 'text' }]
};
write('.obsidian/plugins/tasknotes/data.json', `${JSON.stringify(tasknotes, null, 2)}\n`);
if (TASKNOTES_FROM) {
  for (const f of ['main.js', 'manifest.json', 'styles.css']) {
    const from = path.join(TASKNOTES_FROM, '.obsidian/plugins/tasknotes', f);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(root, '.obsidian/plugins/tasknotes', f));
  }
}
write('.obsidian/plugins/tasknotes-gantt/data.json', `${JSON.stringify({
  groupBy: 'project', zoom: 'week', gridWidth: 440, showCriticalPath: true, showCapacity: false,
  resourceField: 'assignee'
}, null, 2)}\n`);
// Full-width notes, so a block's timeline is not squeezed beside the task list.
write('.obsidian/app.json', `${JSON.stringify({ readableLineLength: false }, null, 2)}\n`);
write('.obsidian/community-plugins.json', '["tasknotes","tasknotes-gantt"]\n');

console.log(`Demo vault: ${root} — ${TASKS.length} tasks across 3 projects, week of ${workday(0)}.`);
if (!TASKNOTES_FROM) {
  console.log('TaskNotes itself was not copied (no TASKNOTES_FROM): install it from the community plugins browser.');
}
