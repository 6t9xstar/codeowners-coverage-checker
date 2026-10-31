import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { analyze, ownershipTree, ownerOf, RULES } from './analyze.js';
import { detectRepo, validateOnGitHub } from './github.js';
import * as R from './reporters.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const TOOL = { name: 'OwnerScope', version: pkg.version, uri: 'https://github.com/6t9xstar/codeowners-coverage-checker' };

const HELP = `OwnerScope ${pkg.version} - GitHub CODEOWNERS validator and coverage checker

Usage
  ownerscope scan                 Validate CODEOWNERS and report problems (default command)
  ownerscope coverage             Coverage summary and ownership per directory
  ownerscope who <paths...>       Show which rule and owners apply to files
  ownerscope rules                List all rules

Options
      --root <dir>          Repository root (default: .)
      --codeowners <file>   CODEOWNERS path (default: .github/CODEOWNERS, CODEOWNERS, docs/CODEOWNERS)
      --fail-under <pct>    Fail when ownership coverage is below this percentage
      --depth <n>           (coverage) directory depth of the ownership tree (default: 2)
      --list-uncovered      (coverage) print every file without an owner
      --github              Validate with the GitHub API (owner, team and syntax errors as GitHub sees them)
      --repo <owner/repo>   Repository for --github (default: from the origin remote)
      --ref <branch>        Branch for --github (default: the default branch)
      --check-access        With --github: verify every owner has write access (needs GITHUB_TOKEN)
  -f, --format <fmt>        text | json | sarif | markdown | github   (default: text)
  -o, --output <file>       Write the report to a file
      --fail-on <level>     error | warning | info | none             (default: error)
      --ignore <ids>        Comma-separated rule ids to skip, e.g. OS006,OS009
      --no-color            Disable colors
  -h, --help / -v, --version

Exit codes: 0 = ok, 1 = findings at or above --fail-on or coverage below --fail-under, 2 = usage error

Docs: ${TOOL.uri}`;

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        root: { type: 'string', default: '.' },
        codeowners: { type: 'string' },
        'fail-under': { type: 'string' },
        depth: { type: 'string', default: '2' },
        'list-uncovered': { type: 'boolean' },
        github: { type: 'boolean' },
        repo: { type: 'string' },
        ref: { type: 'string' },
        'check-access': { type: 'boolean' },
        format: { type: 'string', short: 'f', default: 'text' },
        output: { type: 'string', short: 'o' },
        'fail-on': { type: 'string', default: 'error' },
        ignore: { type: 'string', default: '' },
        'no-color': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (err) {
    return usage(err.message);
  }
  const { values: opts, positionals } = parsed;
  if (opts.version) return print(pkg.version), 0;
  if (opts.help) return print(HELP), 0;
  const command = ['scan', 'coverage', 'who', 'rules'].includes(positionals[0]) ? positionals.shift() : 'scan';
  if (!R.FORMATS.includes(opts.format)) return usage(`Unknown format "${opts.format}"`);
  if (!['error', 'warning', 'info', 'none'].includes(opts['fail-on'])) return usage(`Unknown --fail-on level "${opts['fail-on']}"`);
  const failUnder = opts['fail-under'] === undefined ? null : Number(String(opts['fail-under']).replace('%', ''));
  if (failUnder !== null && (Number.isNaN(failUnder) || failUnder < 0 || failUnder > 100)) return usage('--fail-under must be a number between 0 and 100');
  const depth = Number(opts.depth);
  if (!Number.isInteger(depth) || depth < 0) return usage('--depth must be a non-negative integer');
  const c = R.colors(R.shouldUseColor(opts['no-color'] ? false : undefined));

  if (command === 'rules') {
    for (const [id, r] of Object.entries(RULES)) print(`${c.bold(id)} ${r.name} ${c.gray(`(${r.severity})`)}\n    ${r.description}`);
    return 0;
  }

  const root = path.resolve(opts.root);
  if (!fs.existsSync(root)) return usage(`Root not found: ${opts.root}`);
  if (opts.codeowners && !fs.existsSync(path.resolve(root, opts.codeowners))) return usage(`CODEOWNERS file not found: ${opts.codeowners}`);
  const ignore = new Set(opts.ignore.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
  const result = analyze({ root, file: opts.codeowners, ignore });

  if (command === 'who') {
    if (!positionals.length) return usage('who needs at least one path');
    for (const p of positionals) {
      const rel = path.relative(root, path.resolve(p)).split(path.sep).join('/');
      const rule = ownerOf(result.rules, rel);
      if (!rule) print(`${c.bold(rel)}  ${c.yellow('no code owner')}`);
      else print(`${c.bold(rel)}  ${rule.owners.length ? c.green(rule.owners.join(' ')) : c.yellow('explicitly unowned')}  ${c.gray(`${result.codeownersPath}:${rule.line} ${rule.pattern}`)}`);
    }
    return 0;
  }

  const notes = [];
  if (opts.github && result.codeownersPath) {
    const repo = opts.repo || detectRepo(root);
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return usage('--github needs --repo owner/repo (could not detect it from the origin remote)');
    try {
      const remote = await validateOnGitHub({
        repo,
        ref: opts.ref,
        token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
        rules: result.rules,
        codeownersPath: result.codeownersPath,
        checkAccess: opts['check-access'],
      });
      if (!ignore.has('OS012')) result.findings.push(...remote.findings);
      notes.push(...remote.notes);
    } catch (err) {
      console.error(`ownerscope: ${err.message}`);
      return 2;
    }
  }

  const cov = result.coverage;
  if (failUnder !== null && cov && cov.percent < failUnder && !ignore.has('OS013')) {
    result.findings.push({ ruleId: 'OS013', severity: 'error', message: `Ownership coverage is ${cov.percent.toFixed(1)}%, below the required ${failUnder}%.`, file: result.codeownersPath || '.github/CODEOWNERS', line: 1 });
  }

  const out = render(command, result, opts, c, notes, depth);
  if (opts.output) fs.writeFileSync(opts.output, out + '\n');
  else print(out);
  return result.findings.some((f) => opts['fail-on'] !== 'none' && R.atLeast(f.severity, opts['fail-on'])) || result.findings.some((f) => f.ruleId === 'OS013') ? 1 : 0;
}

function render(command, result, opts, c, notes, depth) {
  const { findings, coverage: cov } = result;
  const tree = cov ? ownershipTree(result.files, result.owners, depth) : [];
  switch (opts.format) {
    case 'json':
      return R.renderJson(findings, {
        tool: TOOL,
        extra: {
          codeowners: result.codeownersPath,
          coverage: cov,
          tree: tree.map((n) => ({ path: n.path, files: n.total, covered: n.covered, percent: pct(n), owners: topOwners(n, 10) })),
          uncoveredFiles: opts['list-uncovered'] && cov ? result.files.filter((f) => !result.owners.get(f)) : undefined,
        },
      });
    case 'sarif':
      return R.renderSarif(findings, { tool: TOOL, rules: RULES });
    case 'markdown': {
      let md = R.renderMarkdown(findings, { tool: TOOL, title: 'OwnerScope Report' });
      if (cov) {
        md += `\n\n### Ownership coverage: ${cov.percent.toFixed(1)}%\n\n| Directory | Files | Covered | Owners |\n| --- | --- | --- | --- |\n`;
        md += tree.map((n) => `| \`${n.path}\` | ${n.total} | ${pct(n).toFixed(1)}% | ${topOwners(n, 3).join(', ') || '—'} |`).join('\n');
      }
      return md;
    }
    case 'github':
      return [R.renderGithub(findings), cov ? `::notice title=OwnerScope coverage::${cov.covered}/${cov.total} files have a code owner (${cov.percent.toFixed(1)}%)` : ''].filter(Boolean).join('\n');
  }

  const lines = [c.bold('OWNERSCOPE REPORT'), ''];
  if (cov) {
    const pad = (label, v) => `${label.padEnd(19)}${v}`;
    lines.push(pad('CODEOWNERS:', result.codeownersPath), pad('Total files:', cov.total), pad('Covered files:', cov.covered), pad('Uncovered files:', cov.uncovered), '');
    lines.push(pad('Invalid rules:', cov.invalidRules), pad('Unmatched rules:', cov.unmatchedRules), pad('Shadowed rules:', cov.shadowedRules), '');
    const color = cov.percent >= 95 ? c.green : cov.percent >= 80 ? c.yellow : c.red;
    lines.push(`Ownership coverage: ${color(c.bold(`${cov.percent.toFixed(1)}%`))}`, '');
  }

  if (command === 'coverage' && cov) {
    lines.push(c.bold('OWNERSHIP BY DIRECTORY'));
    for (const n of tree) {
      const name = n.path === '.' ? '(repository)' : n.path;
      const color = pct(n) >= 95 ? c.green : pct(n) >= 80 ? c.yellow : c.red;
      lines.push(`${'  '.repeat(n.depth)}${name.padEnd(Math.max(10, 34 - n.depth * 2))} ${String(n.total).padStart(6)} files  ${color(`${pct(n).toFixed(1).padStart(5)}%`)}  ${c.gray(topOwners(n, 3).join(', '))}`);
    }
    if (opts['list-uncovered']) {
      const list = result.files.filter((f) => !result.owners.get(f));
      lines.push('', c.bold(`UNCOVERED FILES (${list.length})`), ...list.map((f) => `  ${f}`));
    }
    const rest = findings.filter((f) => f.ruleId !== 'OS006');
    if (rest.length) lines.push('', c.bold('ISSUES'));
    for (const f of R.sortFindings(rest)) lines.push(`${R.severityLabel(f.severity, c)} ${f.message} ${c.gray(`${f.ruleId} ${f.file}:${f.line ?? ''}`)}`);
  } else {
    for (const f of R.sortFindings(findings)) {
      lines.push(`${R.severityLabel(f.severity, c)} ${f.message}`);
      lines.push(c.gray(`          ${f.ruleId} ${f.file}${f.line ? `:${f.line}` : ''}`) + (f.fix ? `  ${c.cyan('Fix:')} ${f.fix}` : ''));
    }
    if (!findings.length) lines.push(c.green('✔ CODEOWNERS is valid and every file has an owner.'));
  }
  for (const n of notes) lines.push(c.gray(n));
  return lines.join('\n');
}

function pct(n) {
  return n.total ? (n.covered / n.total) * 100 : 100;
}

function topOwners(n, k) {
  return [...n.owners.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([o]) => o);
}

function usage(message) {
  console.error(`ownerscope: ${message}\nRun "ownerscope --help" for usage.`);
  return 2;
}

function print(s) {
  process.stdout.write(s + '\n');
}
