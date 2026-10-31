import fs from 'node:fs';
import path from 'node:path';

// Locations GitHub checks, in order. Only the first file found is used.
export const LOCATIONS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
export const MAX_BYTES = 3 * 1024 * 1024;

export function findCodeowners(root) {
  return LOCATIONS.filter((l) => fs.existsSync(path.join(root, l)));
}

const USER = /^@[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const TEAM = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function ownerKind(owner) {
  if (TEAM.test(owner)) return 'team';
  if (USER.test(owner)) return 'user';
  if (EMAIL.test(owner)) return 'email';
  return null;
}

/**
 * Parse CODEOWNERS text.
 * @returns {{line: number, pattern: string, owners: string[], invalidOwners: string[], syntaxError?: string, matcher?: (file: string) => boolean}[]}
 */
export function parseCodeowners(text) {
  const rules = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    const line = idx + 1;
    const content = stripComment(raw).trim();
    if (!content) return;
    const tokens = tokenize(content);
    const pattern = tokens[0];
    const ownerTokens = tokens.slice(1);
    const rule = { line, pattern, owners: [], invalidOwners: [], raw };
    for (const o of ownerTokens) (ownerKind(o) ? rule.owners : rule.invalidOwners).push(o);
    // GitHub skips any line with invalid syntax, including invalid owners.
    if (pattern.startsWith('!')) rule.syntaxError = 'Negation patterns (!) are not supported in CODEOWNERS; the line is ignored.';
    else if (/(^|[^\\])\[/.test(pattern)) rule.syntaxError = 'Character ranges ([...]) are not supported in CODEOWNERS; the line is ignored.';
    else if (rule.invalidOwners.length) rule.syntaxError = `Invalid owner ${rule.invalidOwners.map((o) => `"${o}"`).join(', ')}: owners must be @user, @org/team or an email address. GitHub ignores the whole line.`;
    else rule.matcher = compilePattern(pattern);
    rules.push(rule);
  });
  return rules;
}

function stripComment(line) {
  let out = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && line[i + 1] === '#') {
      out += '\\#';
      i++;
    } else if (line[i] === '#') break;
    else out += line[i];
  }
  return out;
}

function tokenize(content) {
  const tokens = [];
  let cur = '';
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '\\' && content[i + 1] === ' ') {
      cur += ' ';
      i++;
    } else if (/\s/.test(ch)) {
      if (cur) tokens.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/**
 * Compile a CODEOWNERS pattern using GitHub's gitignore-like rules:
 * - a leading "/" or a "/" in the middle anchors the pattern to the repository root
 * - a trailing "/" matches everything inside that directory
 * - "*" does not cross "/"; "docs/*" matches docs/a.md but not docs/x/a.md
 * - "**" matches across directories
 */
export function compilePattern(pattern) {
  let p = pattern.replace(/\\#/g, '#');
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.replace(/\/+$/, '');
  const anchored = p.startsWith('/') || p.includes('/');
  p = p.replace(/^\/+/, '');
  if (p === '' || p === '**') return () => true;

  let body = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      const startSeg = i === 0 || p[i - 1] === '/';
      const endSeg = i + 2 === p.length || p[i + 2] === '/';
      if (startSeg && endSeg) {
        if (i + 2 === p.length) body += '.*';
        else {
          body += '(?:.*/)?';
          i++; // skip the slash after **
        }
        i++;
        continue;
      }
      body += '[^/]*';
      i++;
    } else if (c === '*') body += '[^/]*';
    else if (c === '?') body += '[^/]';
    else if (c === '\\' && i + 1 < p.length) {
      body += escapeRe(p[i + 1]);
      i++;
    } else body += escapeRe(c);
  }
  const prefix = anchored ? '^' : '^(?:.*/)?';
  const lastSegment = p.split('/').pop();
  const allowDir = !/[*?]/.test(lastSegment) || lastSegment === '**';
  const fileRe = dirOnly ? null : new RegExp(`${prefix}${body}$`);
  const dirRe = allowDir || dirOnly ? new RegExp(`${prefix}${body}/.+$`) : null;
  return (file) => Boolean((fileRe && fileRe.test(file)) || (dirRe && dirRe.test(file)));
}

function escapeRe(c) {
  return c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** Owners for a file: the last matching rule wins. */
export function ownerOf(rules, file) {
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i];
    if (r.matcher && r.matcher(file)) return r;
  }
  return null;
}
