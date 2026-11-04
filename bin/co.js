#!/usr/bin/env node
// ponytail: minimal stdlib CLI client; add interactive terminal prompt / TUI if requested.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { launchTui } from './tui.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');

// Load .env if present
function loadEnv() {
  for (const envPath of [resolve(process.cwd(), '.env'), resolve(ROOT_DIR, '.env')]) {
    if (existsSync(envPath)) {
      try {
        const content = readFileSync(envPath, 'utf8');
        for (const line of content.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const idx = trimmed.indexOf('=');
          if (idx !== -1) {
            const k = trimmed.slice(0, idx).trim();
            let v = trimmed.slice(idx + 1).trim();
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
              v = v.slice(1, -1);
            }
            if (!process.env[k]) process.env[k] = v;
          }
        }
      } catch {}
    }
  }
}
loadEnv();

const { values: opts, positionals: rawArgs } = parseArgs({
  args: process.argv.slice(2),
  options: {
    project: { type: 'string', short: 'p' },
    model: { type: 'string', short: 'm' },
    url: { type: 'string', short: 'u' },
    token: { type: 'string', short: 't' },
    watch: { type: 'boolean', short: 'w' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    slug: { type: 'string' },
    repo: { type: 'string' },
    branch: { type: 'string' }
  },
  allowPositionals: true,
  strict: false
});

const API_URL = (opts.url || process.env.ORCHESTRATOR_API_URL || `http://127.0.0.1:${process.env.PORT || 4000}`).replace(/\/+$/, '');
const API_TOKEN = opts.token || process.env.ORCHESTRATOR_API_TOKEN || '';

async function api(path, { method = 'GET', body } = {}) {
  const url = `${API_URL}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (API_TOKEN) headers['Authorization'] = `Bearer ${API_TOKEN}`;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    throw new Error(`Cannot connect to CodeOrchestrator at ${API_URL}: ${e.message}`);
  }

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const msg = data?.error || data?.message || `HTTP ${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return data;
}

function getStoredActiveProject() {
  const candidates = [
    resolve(process.cwd(), '.co-project'),
    resolve(homedir(), '.co-project'),
    resolve(ROOT_DIR, '.co-project'),
    resolve(ROOT_DIR, 'data/.co-project')
  ];
  for (const file of candidates) {
    if (existsSync(file)) {
      try {
        const val = readFileSync(file, 'utf8').trim();
        if (val) return val;
      } catch {}
    }
  }
  return null;
}

function setStoredActiveProject(slug) {
  const clean = slug.trim();
  const cwdFile = resolve(process.cwd(), '.co-project');
  try { writeFileSync(cwdFile, clean + '\n', 'utf8'); } catch {}
  try { writeFileSync(resolve(homedir(), '.co-project'), clean + '\n', 'utf8'); } catch {}
  return clean;
}

async function resolveProject(targetSlug) {
  const target = targetSlug || opts.project || getStoredActiveProject();
  if (!target) {
    throw new Error('No active project. Set one with "co project set <slug>" or pass -p <slug>.');
  }
  const projects = await api('/projects');
  const match = projects.find(p => p.id === target || p.slug === target || p.name.toLowerCase() === target.toLowerCase());
  if (!match) {
    throw new Error(`Project "${target}" not found in CodeOrchestrator.`);
  }
  return match;
}

function printHelp() {
  console.log(`
Usage: co <command> [arguments] [options]
   or: codeorchestrator <command> [arguments] [options]

Commands:
  tui, ui                      Open interactive terminal dashboard
  project list                 List all projects (* marks active project)
  project current              Show active project
  project set <slug>           Set default active project
  project create <name>        Create a new project (--slug, --repo, --branch, --model)
  project import <dir>         Import existing directory as project (--name)
  run <prompt>                 Submit single task to project (-p, -m, -w)
  job <prompt>                 Submit multi-agent job to project (-p, -w)
  status <id>                  Check status of task or job
  tasks [filter]               List tasks by status (run, blok, done, fail)
  approvals                    List pending Gate 3 Git approvals
  approve <id> [decision]      Decide approval (push, create_pr, keep_local, reject)

Options:
  -p, --project <slug>         Override active project
  -m, --model <model>          Specify model override
  -w, --watch                  Poll until task/job finishes
  -u, --url <url>              API base URL (default: http://127.0.0.1:4000)
  -t, --token <token>          API Bearer token
  --json                       Output raw JSON
  -h, --help                   Show this help message
`);
}

async function main() {
  if (opts.help) {
    printHelp();
    return;
  }

  if (rawArgs.length === 0) {
    if (process.stdin.isTTY) {
      return launchTui({
        api,
        getActiveProject: getStoredActiveProject,
        setActiveProject: setStoredActiveProject
      });
    }
    printHelp();
    return;
  }

  const [cmd, ...subArgs] = rawArgs;

  // TUI
  if (cmd === 'tui' || cmd === 'ui') {
    return launchTui({
      api,
      getActiveProject: getStoredActiveProject,
      setActiveProject: setStoredActiveProject
    });
  }

  // Shortcuts
  if (cmd === 'projects') return handleProjectList();
  if (cmd === 'current') return handleProjectCurrent();
  if (cmd === 'use') return handleProjectSet(subArgs[0]);
  if (cmd === 'tasks') return handleTasks(subArgs[0]);
  if (cmd === 'task') {
    if (subArgs[0] === 'list' || subArgs[0] === 'ls') return handleTasks(subArgs[1]);
    return handleRun(subArgs.join(' '));
  }

  switch (cmd) {
    case 'project': {
      const sub = subArgs[0] || 'list';
      if (sub === 'list' || sub === 'ls') return handleProjectList();
      if (sub === 'current' || sub === 'get') return handleProjectCurrent();
      if (sub === 'set' || sub === 'use') return handleProjectSet(subArgs[1]);
      if (sub === 'create') return handleProjectCreate(subArgs.slice(1).join(' '));
      if (sub === 'import') return handleProjectImport(subArgs[1]);
      throw new Error(`Unknown project subcommand: ${sub}`);
    }
    case 'run':
      return handleRun(subArgs.join(' '));
    case 'job':
      return handleJob(subArgs.join(' '));
    case 'status':
      return handleStatus(subArgs[0]);
    case 'tasks':
      return handleTasks(subArgs[0]);
    case 'approvals':
      return handleApprovals();
    case 'approve':
      return handleApprove(subArgs[0], subArgs[1]);
    default:
      throw new Error(`Unknown command "${cmd}". Run "co --help" for usage.`);
  }
}

async function handleProjectList() {
  const projects = await api('/projects');
  if (opts.json) return console.log(JSON.stringify(projects, null, 2));

  const active = getStoredActiveProject();
  console.log(`\nProjects (${projects.length}):`);
  for (const p of projects) {
    const isActive = active && (p.slug === active || p.id === active || p.name.toLowerCase() === active.toLowerCase());
    const marker = isActive ? '* ' : '  ';
    const tag = isActive ? ' [ACTIVE]' : '';
    console.log(`${marker}${p.name} (slug: ${p.slug}, branch: ${p.default_branch || 'main'})${tag}`);
    if (p.repo_url) console.log(`    repo: ${p.repo_url}`);
  }
  console.log('');
}

async function handleProjectCurrent() {
  const activeSlug = getStoredActiveProject();
  if (!activeSlug) {
    console.log('No active project set. Run "co project set <slug>" to select one.');
    return;
  }
  try {
    const project = await resolveProject(activeSlug);
    if (opts.json) return console.log(JSON.stringify(project, null, 2));
    console.log(`Active Project: ${project.name}`);
    console.log(`  Slug:      ${project.slug}`);
    console.log(`  ID:        ${project.id}`);
    console.log(`  Workspace: ${project.workspace_path}`);
    console.log(`  Branch:    ${project.default_branch || 'main'}`);
    if (project.repo_url) console.log(`  Repo:      ${project.repo_url}`);
  } catch {
    console.log(`Active Project: ${activeSlug} (unverified with server)`);
  }
}

async function handleProjectSet(slug) {
  if (!slug) throw new Error('Usage: co project set <slug>');
  const project = await resolveProject(slug);
  setStoredActiveProject(project.slug);
  console.log(`Active project set to: ${project.slug} (${project.name})`);
}

async function handleProjectCreate(name) {
  if (!name) throw new Error('Usage: co project create <name> [--repo <url>] [--branch <branch>] [--slug <slug>]');
  const payload = {
    name,
    slug: opts.slug || undefined,
    repoUrl: opts.repo || undefined,
    branch: opts.branch || undefined,
    defaultModel: opts.model || undefined
  };
  const res = await api('/projects', { method: 'POST', body: payload });
  if (res.slug) setStoredActiveProject(res.slug);
  if (opts.json) return console.log(JSON.stringify(res, null, 2));
  console.log(`Project created: ${res.name} (slug: ${res.slug}, id: ${res.id})`);
  console.log(`Active project set to: ${res.slug}`);
}

async function handleProjectImport(dir) {
  if (!dir) throw new Error('Usage: co project import <directory> [--name <name>]');
  const payload = {
    directory: resolve(process.cwd(), dir),
    name: opts.project || rawArgs[rawArgs.indexOf('--name') + 1] || undefined
  };
  const res = await api('/projects/import', { method: 'POST', body: payload });
  if (res.slug) setStoredActiveProject(res.slug);
  if (opts.json) return console.log(JSON.stringify(res, null, 2));
  console.log(`Project imported: ${res.name} (slug: ${res.slug}, id: ${res.id})`);
  console.log(`Active project set to: ${res.slug}`);
}

async function handleRun(prompt) {
  if (!prompt || !prompt.trim()) throw new Error('Prompt required. Usage: co run "<prompt>"');
  const project = await resolveProject();
  const payload = {
    prompt: prompt.trim(),
    model: opts.model || undefined
  };
  const task = await api(`/projects/${project.id}/tasks`, { method: 'POST', body: payload });
  if (opts.json && !opts.watch) return console.log(JSON.stringify(task, null, 2));

  console.log(`Task submitted: ${task.id}`);
  console.log(`Project:        ${project.slug}`);
  console.log(`Status:         ${task.status}`);

  if (opts.watch) {
    await pollTask(task.id);
  }
}

async function handleJob(prompt) {
  if (!prompt || !prompt.trim()) throw new Error('Prompt required. Usage: co job "<prompt>"');
  const project = await resolveProject();
  const payload = {
    project_id: project.id,
    prompt: prompt.trim()
  };
  const job = await api('/jobs', { method: 'POST', body: payload });
  if (opts.json && !opts.watch) return console.log(JSON.stringify(job, null, 2));

  console.log(`Job submitted:  ${job.id}`);
  console.log(`Project:        ${project.slug}`);
  if (job.subtaskId) console.log(`Subtask:        ${job.subtaskId}`);

  if (opts.watch) {
    await pollJob(job.id);
  }
}

async function handleStatus(id) {
  if (!id) throw new Error('Usage: co status <id>');
  let data = null;
  let kind = 'task';

  try {
    data = await api(`/tasks/${id}`);
    kind = 'task';
  } catch (err) {
    try {
      data = await api(`/jobs/${id}`);
      kind = 'job';
    } catch {
      data = await api(`/approvals/${id}`);
      kind = 'approval';
    }
  }

  if (opts.json) return console.log(JSON.stringify(data, null, 2));

  console.log(`Type:   ${kind.toUpperCase()}`);
  console.log(`ID:     ${data.id}`);
  console.log(`Status: ${data.status || 'unknown'}`);
  if (data.prompt) console.log(`Prompt: ${data.prompt}`);
  if (data.summary) console.log(`Summary:\n${data.summary}`);
  if (data.error) console.log(`Error:  ${data.error}`);
  if (data.workflow_status) console.log(`Workflow: ${data.workflow_status}`);
}

async function handleApprovals() {
  const activeSlug = getStoredActiveProject();
  let projectId = null;
  if (activeSlug && !opts.project) {
    try {
      const p = await resolveProject(activeSlug);
      projectId = p.id;
    } catch {}
  } else if (opts.project) {
    const p = await resolveProject(opts.project);
    projectId = p.id;
  }

  const user = encodeURIComponent(process.env.USER || 'cli-user');
  const projQuery = projectId ? `&projectId=${encodeURIComponent(projectId)}` : '';
  const approvals = await api(`/approvals/pending?userId=${user}${projQuery}`);

  if (opts.json) return console.log(JSON.stringify(approvals, null, 2));

  if (!approvals || approvals.length === 0) {
    console.log('No pending approvals.');
    return;
  }

  console.log(`\nPending Approvals (${approvals.length}):`);
  for (const a of approvals) {
    console.log(`- [${a.id}] Project: ${a.project_id}`);
    console.log(`  Task/Job:    ${a.task_id || a.job_id || 'N/A'}`);
    console.log(`  Base Branch: ${a.base_branch || 'main'}`);
    console.log(`  Created:     ${a.created_at || 'unknown'}`);
    console.log(`  Action:      co approve ${a.id} [push|create_pr|keep_local|reject]\n`);
  }
}

async function handleApprove(id, decisionRaw) {
  if (!id) throw new Error('Usage: co approve <id> [push|create_pr|keep_local|reject]');
  const mapping = {
    approve: 'push',
    approved: 'push',
    push: 'push',
    pr: 'create_pr',
    create_pr: 'create_pr',
    keep: 'keep_local',
    keep_local: 'keep_local',
    reject: 'reject',
    rejected: 'reject'
  };
  const decision = mapping[(decisionRaw || 'push').toLowerCase()] || decisionRaw;
  const res = await api(`/approvals/${id}/decide`, {
    method: 'POST',
    body: {
      decision,
      userId: process.env.USER || 'cli-user'
    }
  });

  if (opts.json) return console.log(JSON.stringify(res, null, 2));
  console.log(`Approval ${id} decided: ${decision}`);
  if (res.message) console.log(`Result: ${res.message}`);
}

async function pollTask(taskId) {
  process.stdout.write(`Waiting for task ${taskId} to complete...`);
  const terminal = new Set(['completed', 'failed', 'blocked', 'cancelled']);
  while (true) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const t = await api(`/tasks/${taskId}`);
      if (terminal.has(t.status)) {
        console.log(`\nTerminal status reached: ${t.status}`);
        if (t.summary) console.log(`Summary:\n${t.summary}`);
        if (t.error) console.log(`Error: ${t.error}`);
        return t;
      }
      process.stdout.write('.');
    } catch {
      process.stdout.write('?');
    }
  }
}

async function pollJob(jobId) {
  process.stdout.write(`Waiting for job ${jobId} to complete...`);
  const terminal = new Set(['completed', 'failed', 'cancelled']);
  while (true) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const j = await api(`/jobs/${jobId}`);
      if (terminal.has(j.status)) {
        console.log(`\nTerminal status reached: ${j.status}`);
        return j;
      }
      process.stdout.write('.');
    } catch {
      process.stdout.write('?');
    }
  }
}

async function handleTasks(filter) {
  const [tasks, projects] = await Promise.all([
    api('/tasks'),
    api('/projects').catch(() => [])
  ]);

  if (opts.json) return console.log(JSON.stringify(tasks, null, 2));

  const projectMap = new Map((projects || []).map(p => [p.id, p.slug || p.name]));

  const getPriority = (t) => {
    const st = (t.status || '').toLowerCase();
    const wf = (t.workflow_status || '').toLowerCase();
    if (st === 'running' || st === 'queued' || wf === 'verifying' || wf === 'auditing') return 1;
    if (st === 'blocked' || wf === 'blocked' || wf === 'awaiting_approval' || st === 'interrupted') return 2;
    if (st === 'completed' || wf === 'completed') return 3;
    return 4;
  };

  const getBadge = (t) => {
    const st = (t.status || '').toLowerCase();
    const wf = (t.workflow_status || '').toLowerCase();
    if (st === 'running') return 'RUN ';
    if (st === 'queued') return 'QUE ';
    if (wf === 'verifying') return 'VRFY';
    if (wf === 'auditing') return 'AUDT';
    if (st === 'blocked' || wf === 'blocked') return 'BLOK';
    if (wf === 'awaiting_approval') return 'APPR';
    if (st === 'completed') return 'DONE';
    if (st === 'failed' || wf === 'failed') return 'FAIL';
    if (st === 'cancelled') return 'CANC';
    return (st.slice(0, 4) || 'UNKN').toUpperCase();
  };

  let list = [...(tasks || [])];
  list.sort((a, b) => {
    const pa = getPriority(a);
    const pb = getPriority(b);
    if (pa !== pb) return pa - pb;
    return (b.created_at || '').localeCompare(a.created_at || '');
  });

  if (filter) {
    const f = filter.toUpperCase();
    list = list.filter(t => {
      const p = getPriority(t);
      if (f === 'RUN' || f === 'RUNNING') return p === 1;
      if (f === 'BLOK' || f === 'BLOCKED') return p === 2;
      if (f === 'DONE' || f === 'COMPLETED') return p === 3;
      if (f === 'FAIL' || f === 'FAILED') return p === 4;
      const proj = projectMap.get(t.project_id) || '';
      return (t.status || '').toUpperCase().includes(f) ||
             (t.workflow_status || '').toUpperCase().includes(f) ||
             proj.toUpperCase().includes(f) ||
             (t.prompt || '').toUpperCase().includes(f);
    });
  }

  const runCount = (tasks || []).filter(t => [1].includes(getPriority(t))).length;
  const blockCount = (tasks || []).filter(t => [2].includes(getPriority(t))).length;
  const doneCount = (tasks || []).filter(t => [3].includes(getPriority(t))).length;
  const failCount = (tasks || []).filter(t => [4].includes(getPriority(t))).length;

  console.log(`\nTasks (RUN: ${runCount} | BLOK: ${blockCount} | DONE: ${doneCount} | FAIL: ${failCount}):`);
  console.log('STATUS | PROJECT      | PROMPT');
  console.log('-------+--------------+--------------------------------------------------');

  if (!list.length) {
    console.log('No tasks found.');
    console.log('');
    return;
  }

  for (const t of list) {
    const badge = getBadge(t).padEnd(6);
    const proj = (projectMap.get(t.project_id) || t.project_id || 'general').slice(0, 12).padEnd(12);
    const prompt = (t.prompt || '').replace(/\r?\n/g, ' ').slice(0, 50);
    console.log(`${badge} | ${proj} | ${prompt}`);
  }
  console.log('');
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
