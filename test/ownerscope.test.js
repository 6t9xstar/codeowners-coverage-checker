import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compilePattern, parseCodeowners, ownerOf, ownerKind } from '../src/codeowners.js';
import { analyze, ownershipTree } from '../src/analyze.js';
import { validateOnGitHub } from '../src/github.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'ownerscope.js');

const FILES = [
  'README.md',
  'package.json',
  'docs/index.md',
  'docs/guide/setup.md',
  'src/api/server.ts',
  'src/api/v1/users.ts',
  'src/web/app.tsx',
  'apps/mobile/main.dart',
  'packages/ui/apps/x.js',
  'build/logs/out.log',
  'scripts/release.sh',
];
const m = (pattern) => FILES.filter(compilePattern(pattern));

test('pattern matching follows GitHub CODEOWNERS semantics', () => {
  assert.deepEqual(m('*'), FILES);
  assert.deepEqual(m('*.md'), ['README.md', 'docs/index.md', 'docs/guide/setup.md']);
  assert.deepEqual(m('/docs/'), ['docs/index.md', 'docs/guide/setup.md']);
  // GitHub: docs/* matches direct children only.
  assert.deepEqual(m('docs/*'), ['docs/index.md']);
  assert.deepEqual(m('docs/**'), ['docs/index.md', 'docs/guide/setup.md']);
  // No leading slash and no inner slash: matches a directory anywhere.
  assert.deepEqual(m('apps/'), ['apps/mobile/main.dart', 'packages/ui/apps/x.js']);
  assert.deepEqual(m('/apps/'), ['apps/mobile/main.dart']);
  assert.deepEqual(m('**/logs'), ['build/logs/out.log']);
  assert.deepEqual(m('/build/logs/'), ['build/logs/out.log']);
  assert.deepEqual(m('src/**/users.ts'), ['src/api/v1/users.ts']);
  assert.deepEqual(m('/src/api/*.ts'), ['src/api/server.ts']);
  assert.deepEqual(m('package.json'), ['package.json']);
  assert.deepEqual(m('/scripts/release.sh'), ['scripts/release.sh']);
  assert.deepEqual(m('Docs/'), []); // case-sensitive
  assert.deepEqual(m('?EADME.md'), ['README.md']);
});

test('parseCodeowners: comments, escapes, owners and unsupported syntax', () => {
  const rules = parseCodeowners('# comment\n\n*.js @a @org/team user@example.com # trailing\n\\#file @b\n!x @c\n[ab].js @d\nfoo bad-owner\n/unowned\n');
  assert.equal(rules.length, 6);
  assert.deepEqual(rules[0].owners, ['@a', '@org/team', 'user@example.com']);
  assert.equal(rules[1].pattern, '\\#file');
  assert.ok(rules[1].matcher('#file'));
  assert.match(rules[2].syntaxError, /Negation/);
  assert.match(rules[3].syntaxError, /Character ranges/);
  assert.match(rules[4].syntaxError, /Invalid owner/);
  assert.equal(rules[5].owners.length, 0);
  assert.equal(ownerKind('@octo-cat'), 'user');
  assert.equal(ownerKind('@my-org/web_team'), 'team');
  assert.equal(ownerKind('@-bad'), null);
});

test('ownerOf: the last matching rule wins', () => {
  const rules = parseCodeowners('* @everyone\n/docs/ @docs\n/docs/api.md\n');
  assert.deepEqual(ownerOf(rules, 'src/x.js').owners, ['@everyone']);
  assert.deepEqual(ownerOf(rules, 'docs/a.md').owners, ['@docs']);
  assert.deepEqual(ownerOf(rules, 'docs/api.md').owners, []);
});

function repo(codeowners, files = FILES, where = '.github/CODEOWNERS') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownerscope-'));
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), '');
  }
  if (codeowners !== null) {
    fs.mkdirSync(path.dirname(path.join(dir, where)), { recursive: true });
    fs.writeFileSync(path.join(dir, where), codeowners);
  }
  return dir;
}

test('analyze: full coverage and a clean file', () => {
  const dir = repo('* @acme/maintainers\n/docs/ @acme/docs\n');
  const { findings, coverage } = analyze({ root: dir, files: FILES });
  assert.deepEqual(findings, []);
  assert.equal(coverage.percent, 100);
});

test('analyze: unmatched, shadowed, duplicate, invalid and uncovered', () => {
  const dir = repo('/docs/ @docs\n/src/ @dev\n/src/ @dev2\n/nope/ @x\n/Docs/ @y\n!foo @z\n*.md @w\n/package.json\n');
  const { findings, coverage } = analyze({ root: dir, files: FILES });
  const ids = findings.map((f) => f.ruleId);
  for (const id of ['OS002', 'OS003', 'OS004', 'OS005', 'OS006', 'OS009']) assert.ok(ids.includes(id), id);
  assert.match(findings.find((f) => f.ruleId === 'OS004').message, /line 7/);
  assert.match(findings.find((f) => f.context === '/Docs/').fix, /case-sensitive/);
  assert.ok(coverage.percent < 100);
  assert.equal(coverage.invalidRules, 1);
});

test('analyze: catch-all at the bottom is reported with a precise fix', () => {
  const dir = repo('/src/ @dev\n* @all\n');
  const f = analyze({ root: dir, files: FILES }).findings.find((x) => x.ruleId === 'OS004');
  assert.equal(f.fix, 'move "*" to the top of the file');
});

test('analyze: CODEOWNERS location rules', () => {
  assert.equal(analyze({ root: repo(null), files: FILES }).findings[0].ruleId, 'OS001');
  const dir = repo('* @a\n');
  fs.writeFileSync(path.join(dir, 'CODEOWNERS'), '* @b\n');
  const { findings, codeownersPath } = analyze({ root: dir, files: FILES });
  assert.equal(codeownersPath, '.github/CODEOWNERS');
  assert.ok(findings.some((f) => f.ruleId === 'OS007' && f.file === 'CODEOWNERS'));
  assert.equal(analyze({ root: repo('* @a\n', FILES, 'docs/CODEOWNERS'), files: FILES }).codeownersPath, 'docs/CODEOWNERS');
});

test('ownershipTree aggregates per directory', () => {
  const dir = repo('* @all\n/src/ @dev\n/docs/\n');
  const r = analyze({ root: dir, files: FILES });
  const tree = ownershipTree(r.files, r.owners, 1);
  const rootNode = tree.find((n) => n.path === '.');
  const docs = tree.find((n) => n.path === 'docs/');
  assert.equal(rootNode.total, FILES.length);
  assert.equal(docs.covered, 0);
  assert.equal(tree.find((n) => n.path === 'src/').owners.get('@dev'), 3);
});

test('validateOnGitHub maps API errors and access problems', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    const json = (status, body) => ({ status, json: async () => body });
    if (url.endsWith('/codeowners/errors')) return json(200, { errors: [{ line: 3, column: 5, kind: 'Unknown owner', source: '* @ghost', suggestion: 'make sure @ghost exists' }] });
    if (url.includes('/collaborators/reader/permission')) return json(200, { permission: 'read' });
    if (url.includes('/collaborators/writer/permission')) return json(200, { permission: 'write' });
    if (url.includes('/teams/missing/')) return json(404, {});
    return json(404, {});
  };
  const rules = parseCodeowners('* @reader @writer\n/x/ @org/missing\n');
  const { findings } = await validateOnGitHub({ repo: 'o/r', token: 't', rules, codeownersPath: '.github/CODEOWNERS', checkAccess: true, fetchImpl: fakeFetch });
  assert.equal(findings.length, 3);
  assert.match(findings[0].message, /Unknown owner/);
  assert.ok(findings.some((f) => /@reader has "read" access/.test(f.message)));
  assert.ok(findings.some((f) => /Team @org\/missing/.test(f.message)));
  assert.ok(!findings.some((f) => f.message.includes('@writer')));

  await assert.rejects(() => validateOnGitHub({ repo: 'o/r', rules, codeownersPath: 'x', fetchImpl: async () => ({ status: 404, json: async () => ({}) }) }), /404/);
});

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: root, env: { ...process.env, NO_COLOR: '1' } });
}

test('CLI: scan, coverage, who and formats', () => {
  const dir = repo('* @all\n/src/ @dev\n/nope/ @x\n');
  const scan = run(['--root', dir]);
  assert.equal(scan.status, 0); // only warnings
  assert.match(scan.stdout, /Ownership coverage: 100.0%/);
  assert.equal(run(['--root', dir, '--fail-on', 'warning']).status, 1);

  const cov = run(['coverage', '--root', dir, '--depth', '1']);
  assert.match(cov.stdout, /OWNERSHIP BY DIRECTORY/);
  assert.match(cov.stdout, /src\/ +3 files +100.0%/);

  const who = run(['who', '--root', dir, path.join(dir, 'src/api/server.ts')]);
  assert.match(who.stdout, /src\/api\/server.ts +@dev/);

  const json = JSON.parse(run(['--root', dir, '-f', 'json', '--list-uncovered']).stdout);
  assert.equal(json.coverage.total, FILES.length + 1); // + .github/CODEOWNERS itself
  assert.deepEqual(json.uncoveredFiles, []);
  const sarif = JSON.parse(run(['--root', dir, '-f', 'sarif']).stdout);
  assert.equal(sarif.runs[0].tool.driver.name, 'OwnerScope');
  assert.match(run(['--root', dir, '-f', 'github']).stdout, /::notice title=OwnerScope coverage::/);
  assert.match(run(['--root', dir, '-f', 'markdown']).stdout, /Ownership coverage: 100.0%/);
});

test('CLI: --fail-under and usage errors', () => {
  const dir = repo('/src/ @dev\n');
  const r = run(['--root', dir, '--fail-under', '90']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /below the required 90%/);
  assert.equal(run(['--root', dir, '--fail-under', '20']).status, 0);
  assert.equal(run(['--root', dir, '--fail-under', 'abc']).status, 2);
  assert.equal(run(['--root', 'does-not-exist']).status, 2);
  assert.equal(run(['--root', repo(null)]).status, 1);
});
