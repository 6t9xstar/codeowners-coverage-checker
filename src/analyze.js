import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findCodeowners, parseCodeowners, ownerOf, compilePattern, MAX_BYTES } from './codeowners.js';

export const RULES = {
  OS001: { name: 'no-codeowners-file', severity: 'error', description: 'No CODEOWNERS file in .github/, the root or docs/.' },
  OS002: { name: 'invalid-syntax', severity: 'error', description: 'Unsupported syntax or invalid owner; GitHub skips the whole line.' },
  OS003: { name: 'unmatched-rule', severity: 'warning', description: 'The pattern matches no file in the repository.' },
  OS004: { name: 'shadowed-rule', severity: 'warning', description: 'Every file the rule matches is overridden by a later rule, so it never takes effect.' },
  OS005: { name: 'duplicate-pattern', severity: 'warning', description: 'The same pattern appears again later; only the last one counts.' },
  OS006: { name: 'uncovered-files', severity: 'warning', description: 'Files with no code owner (no reviewer is requested automatically).' },
  OS007: { name: 'multiple-codeowners-files', severity: 'warning', description: 'More than one CODEOWNERS file exists; GitHub only uses the first.' },
  OS008: { name: 'file-too-large', severity: 'error', description: 'CODEOWNERS files over 3 MB are ignored by GitHub.' },
  OS009: { name: 'explicitly-unowned', severity: 'info', description: 'A pattern without owners removes ownership for matching files.' },
  OS010: { name: 'email-owner', severity: 'info', description: 'Email owners only work when the address is verified on a GitHub account with access.' },
  OS011: { name: 'duplicate-owner', severity: 'info', description: 'The same owner is listed twice on one line.' },
  OS012: { name: 'github-validation', severity: 'error', description: 'GitHub reports an error for this line (unknown owner, missing access, ...).' },
  OS013: { name: 'below-coverage-threshold', severity: 'error', description: 'Ownership coverage is below --fail-under.' },
};

/** List repository files: tracked + untracked-but-not-ignored, falling back to a directory walk. */
export function listRepoFiles(root) {
  const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (git.status === 0 && git.stdout) {
    return [...new Set(git.stdout.split('\0').filter(Boolean))].filter((f) => fs.existsSync(path.join(root, f))).sort();
  }
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out.push(r);
    }
  };
  walk(root, '');
  return out.sort();
}

/**
 * Analyze CODEOWNERS for a repository.
 * @param {{root: string, file?: string, files?: string[], ignore?: Set<string>}} options
 */
export function analyze({ root, file, files, ignore = new Set() }) {
  const findings = [];
  const add = (ruleId, line, message, extra = {}) => {
    if (!ignore.has(ruleId)) findings.push({ ruleId, severity: extra.severity || RULES[ruleId].severity, message, fix: extra.fix, file: extra.file || codeownersPath, line, context: extra.context });
  };

  const present = findCodeowners(root);
  const codeownersPath = file ? path.relative(root, path.resolve(root, file)).split(path.sep).join('/') : present[0];
  if (!codeownersPath || !fs.existsSync(path.join(root, codeownersPath))) {
    findings.push({ ruleId: 'OS001', severity: 'error', message: 'No CODEOWNERS file found.', fix: 'create .github/CODEOWNERS, e.g. "* @your-org/maintainers"', file: '.github/CODEOWNERS', line: 1 });
    return { findings, rules: [], files: [], coverage: null, codeownersPath: null };
  }
  if (!file && present.length > 1) {
    for (const extra of present.slice(1)) add('OS007', 1, `${extra} is ignored because ${present[0]} takes precedence.`, { file: extra, fix: `merge it into ${present[0]} and delete it` });
  }

  const abs = path.join(root, codeownersPath);
  const size = fs.statSync(abs).size;
  if (size > MAX_BYTES) add('OS008', 1, `CODEOWNERS is ${(size / 1024 / 1024).toFixed(1)} MB; GitHub ignores files over 3 MB.`, { fix: 'use directory patterns and teams instead of listing individual files' });

  const rules = parseCodeowners(fs.readFileSync(abs, 'utf8'));
  files = files || listRepoFiles(root);

  // Syntax / owners ---------------------------------------------------------
  for (const r of rules) {
    if (r.syntaxError) add('OS002', r.line, r.syntaxError, { context: r.pattern });
    if (!r.syntaxError && r.owners.length === 0) add('OS009', r.line, `"${r.pattern}" has no owners, so matching files have no code owner.`, { context: r.pattern });
    const emails = r.owners.filter((o) => !o.startsWith('@'));
    if (emails.length) add('OS010', r.line, `${emails.join(', ')} must be a verified email of a GitHub user with write access.`, { context: r.pattern, fix: 'prefer @username or @org/team' });
    const dup = r.owners.filter((o, i) => r.owners.findIndex((x) => x.toLowerCase() === o.toLowerCase()) !== i);
    if (dup.length) add('OS011', r.line, `${[...new Set(dup)].join(', ')} listed more than once.`, { context: r.pattern });
  }

  // Ownership resolution --------------------------------------------------
  const active = rules.filter((r) => r.matcher);
  const matchedBy = new Map(active.map((r) => [r, 0]));
  const effective = new Map(active.map((r) => [r, 0]));
  const owners = new Map();
  const overriddenBy = new Map();
  for (const f of files) {
    let winner = null;
    for (let i = active.length - 1; i >= 0; i--) {
      const r = active[i];
      if (!r.matcher(f)) continue;
      matchedBy.set(r, matchedBy.get(r) + 1);
      if (!winner) winner = r;
      else if (!overriddenBy.has(r)) overriddenBy.set(r, winner);
    }
    if (winner) effective.set(winner, effective.get(winner) + 1);
    owners.set(f, winner && winner.owners.length ? winner : null);
  }

  const lastIndexOfPattern = new Map();
  active.forEach((r, i) => lastIndexOfPattern.set(normalisePattern(r.pattern), i));
  active.forEach((r, i) => {
    const later = lastIndexOfPattern.get(normalisePattern(r.pattern));
    if (later !== i) {
      add('OS005', r.line, `"${r.pattern}" is repeated on line ${active[later].line}; this line has no effect.`, { context: r.pattern, fix: 'delete one of the two lines' });
    } else if (matchedBy.get(r) === 0) {
      const ciMatcher = compilePattern(r.pattern.toLowerCase());
      const ci = files.find((f) => ciMatcher(f.toLowerCase()));
      add('OS003', r.line, `"${r.pattern}" matches no files.`, { context: r.pattern, fix: ci ? `paths are case-sensitive: it would match "${ci}" with different casing` : 'remove the rule or fix the path' });
    } else if (effective.get(r) === 0) {
      const by = overriddenBy.get(r);
      const catchAll = by && ['*', '/*', '**', '/**', '/'].includes(by.pattern);
      add('OS004', r.line, `"${r.pattern}" matches ${matchedBy.get(r)} file(s), but later rules override all of them${by ? ` (e.g. "${by.pattern}" on line ${by.line})` : ''}. The last matching rule wins.`, {
        context: r.pattern,
        fix: catchAll ? `move "${by.pattern}" to the top of the file` : 'move this rule below the broader rules, or delete it',
      });
    }
  });

  const uncovered = files.filter((f) => !owners.get(f));
  const coverage = {
    total: files.length,
    covered: files.length - uncovered.length,
    uncovered: uncovered.length,
    percent: files.length ? ((files.length - uncovered.length) / files.length) * 100 : 100,
    invalidRules: rules.filter((r) => r.syntaxError).length,
    unmatchedRules: findings.filter((f) => f.ruleId === 'OS003').length,
    shadowedRules: findings.filter((f) => f.ruleId === 'OS004' || f.ruleId === 'OS005').length,
  };

  if (uncovered.length) {
    const groups = new Map();
    for (const f of uncovered) {
      const top = f.includes('/') ? f.slice(0, f.indexOf('/') + 1) : f;
      groups.set(top, [...(groups.get(top) || []), f]);
    }
    for (const [top, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const isDir = top.endsWith('/');
      add('OS006', undefined, isDir ? `${list.length} file(s) in ${top} have no code owner (e.g. ${list.slice(0, 3).join(', ')}).` : `${top} has no code owner.`, {
        context: top,
        fix: isDir ? `/${top} @owner` : `/${top} @owner`,
      });
    }
  }

  return { findings, rules, files, owners, coverage, codeownersPath };
}

function normalisePattern(p) {
  return p.replace(/^\/+/, '/').replace(/\/\*\*$/, '/');
}

/** Directory tree with coverage and top owners, limited to a depth. */
export function ownershipTree(files, owners, depth = 2) {
  const nodes = new Map();
  for (const f of files) {
    const parts = f.split('/');
    const dirs = ['.'];
    for (let d = 1; d <= Math.min(depth, parts.length - 1); d++) dirs.push(parts.slice(0, d).join('/') + '/');
    dirs.forEach((key, d) => {
      const n = nodes.get(key) || { path: key, depth: d, total: 0, covered: 0, owners: new Map() };
      n.total++;
      const rule = owners.get(f);
      if (rule) {
        n.covered++;
        for (const o of rule.owners) n.owners.set(o, (n.owners.get(o) || 0) + 1);
      }
      nodes.set(key, n);
    });
  }
  return [...nodes.values()].sort((a, b) => (a.path === '.' ? -1 : b.path === '.' ? 1 : a.path.localeCompare(b.path)));
}

export { ownerOf };
