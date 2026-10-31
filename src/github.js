import { spawnSync } from 'node:child_process';

const API = 'https://api.github.com';

/** owner/repo from the "origin" remote, if it points at github.com. */
export function detectRepo(root) {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = r.stdout.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function client(token, fetchImpl) {
  return async (url, accept = 'application/vnd.github+json') => {
    const res = await fetchImpl(`${API}${url}`, {
      headers: {
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ownerscope',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  };
}

/**
 * Ask GitHub to validate the CODEOWNERS file on a branch, and optionally check
 * that every owner has write access.
 * @returns {Promise<{findings: object[], notes: string[]}>}
 */
export async function validateOnGitHub({ repo, ref, token, rules, codeownersPath, checkAccess = false, fetchImpl = globalThis.fetch }) {
  const get = client(token, fetchImpl);
  const findings = [];
  const notes = [];
  const add = (line, message, context) => findings.push({ ruleId: 'OS012', severity: 'error', message, file: codeownersPath, line, ...(context ? { context } : {}) });

  const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const res = await get(`/repos/${repo}/codeowners/errors${q}`);
  if (res.status === 404) {
    throw new Error(`GitHub returned 404 for ${repo}${ref ? `@${ref}` : ''}: the repository, branch or CODEOWNERS file was not found (private repositories need GITHUB_TOKEN).`);
  }
  if (res.status === 403 || res.status === 429) throw new Error(`GitHub API rate limit or permission error (${res.status}). Set GITHUB_TOKEN.`);
  if (res.status !== 200) throw new Error(`GitHub API error ${res.status}: ${res.body?.message || 'unknown error'}`);
  const errors = res.body.errors || [];
  for (const e of errors) {
    const suggestion = e.suggestion ? ` ${e.suggestion.charAt(0).toUpperCase()}${e.suggestion.slice(1)}.` : '';
    add(e.line, `GitHub: ${e.kind}${e.source ? ` in "${e.source.trim()}"` : ''}.${suggestion}`);
  }
  notes.push(`GitHub checked the CODEOWNERS file on ${ref || 'the default branch'} of ${repo}: ${errors.length} error(s).`);
  if (!token && errors.some((e) => /unknown owner/i.test(e.kind))) {
    notes.push('Without GITHUB_TOKEN, teams that are not publicly visible are reported as unknown owners.');
  }

  if (checkAccess) {
    if (!token) {
      notes.push('Skipped the write-access check: it needs GITHUB_TOKEN with read access to the repository collaborators.');
      return { findings, notes };
    }
    const lineFor = new Map();
    for (const r of rules) for (const o of r.owners) if (!lineFor.has(o.toLowerCase())) lineFor.set(o.toLowerCase(), r.line);
    const [owner, name] = repo.split('/');
    for (const [o, line] of lineFor) {
      if (!o.startsWith('@')) continue;
      if (o.includes('/')) {
        const [org, slug] = o.slice(1).split('/');
        const team = await get(`/orgs/${org}/teams/${slug}/repos/${owner}/${name}`, 'application/vnd.github.v3.repository+json');
        if (team.status === 404) add(line, `Team ${o} does not exist, is not visible to the token, or has no access to ${repo}.`, o);
        else if (team.status === 200 && team.body?.permissions && !team.body.permissions.push) add(line, `Team ${o} has read-only access to ${repo}; GitHub ignores owners without write access.`, o);
      } else {
        const login = o.slice(1);
        const perm = await get(`/repos/${repo}/collaborators/${login}/permission`);
        if (perm.status === 404) add(line, `User ${o} does not exist or is not a collaborator on ${repo}.`, o);
        else if (perm.status === 200 && !['admin', 'maintain', 'write'].includes(perm.body?.permission)) add(line, `User ${o} has "${perm.body?.permission}" access to ${repo}; GitHub ignores owners without write access.`, o);
        else if (perm.status === 403) {
          notes.push('The token cannot read collaborator permissions; skipped the write-access check.');
          break;
        }
      }
    }
  }
  return { findings, notes };
}
