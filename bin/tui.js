// ponytail: stdlib ANSI 2-pane TUI; upgrade to blessed/ink if complex multi-window drag needed.
import readline from 'node:readline';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  rev: '\x1b[7m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  bgBlue: '\x1b[44m',
  bgGray: '\x1b[100m',
  clear: '\x1b[2J\x1b[H',
  home: '\x1b[H',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h'
};

export const stripAnsi = (str = '') => String(str).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
export const visibleLen = (str = '') => stripAnsi(str).length;

export function wrapText(text = '', maxWidth = 50) {
  if (!text) return [''];
  const words = String(text).split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) {
      cur = w;
    } else if (visibleLen(cur + ' ' + w) <= maxWidth) {
      cur += ' ' + w;
    } else {
      lines.push(cur);
      cur = w;
    }
    while (visibleLen(cur) > maxWidth) {
      lines.push(cur.slice(0, maxWidth));
      cur = cur.slice(maxWidth);
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

export function fit(str = '', width = 0, padChar = ' ') {
  const len = visibleLen(str);
  if (len === width) return str;
  if (len > width) {
    const raw = stripAnsi(str);
    return raw.slice(0, Math.max(0, width - 1)) + '…';
  }
  return str + padChar.repeat(Math.max(0, width - len));
}

export function progressBar(percent = 0, width = 16) {
  const p = Math.max(0, Math.min(100, percent));
  const filled = Math.round((p / 100) * width);
  const empty = width - filled;
  const color = p > 85 ? C.red : p > 65 ? C.yellow : C.green;
  return `${color}${'█'.repeat(filled)}${C.gray}${'░'.repeat(empty)}${C.reset} ${fit(`${Math.round(p)}%`, 4)}`;
}

export class TerminalUi {
  constructor({ api, getActiveProject, setActiveProject }) {
    this.api = api;
    this.getActiveProject = getActiveProject;
    this.setActiveProject = setActiveProject;
    this.tabIndex = 0; // 0: Projects, 1: Tasks, 2: Approvals, 3: System
    this.tabs = ['projects', 'tasks', 'approvals', 'system'];
    this.tabSelected = { projects: null, tasks: 0, approvals: 0, system: 0 };
    this.selected = 0;
    this.filter = '';
    this.filtering = false;
    this.status = 'Ready. Use [↑↓] to navigate, [Enter] to select, [?] for help.';
    this.projects = [];
    this.tasks = [];
    this.taskStatusFilter = 'ALL'; // 'ALL', 'RUNNING', 'BLOCKED', 'COMPLETED', 'FAILED'
    this.approvals = [];
    this.autoApprove = false;
    this.isProcessingAutoApprove = false;
    this.health = null;
    this.activeSlug = this.getActiveProject ? this.getActiveProject() : null;
    this.activeProject = null;
    this.hasInitializedProjectSelection = false;
    this.modal = null; // { title, type: 'info'|'input'|'form'|'confirm', ... }
    this.inputBuffer = '';
    this.isPasting = false;
    this.pasteBuffer = '';
    this.running = false;
    this.pollTimer = null;
  }

  get tab() {
    return this.tabs[this.tabIndex];
  }

  set tab(val) {
    const idx = this.tabs.indexOf(val);
    if (idx !== -1) this.switchTab(idx);
  }

  getTabSelected(tab) {
    const items = this.getFilteredItems();
    if (tab === 'projects') {
      const saved = this.tabSelected?.projects;
      if (typeof saved === 'number' && saved >= 0 && saved < items.length) {
        return saved;
      }
      const actIdx = items.findIndex(p => p.slug === this.activeSlug || p.id === this.activeSlug);
      if (actIdx !== -1) {
        if (this.tabSelected) this.tabSelected.projects = actIdx;
        return actIdx;
      }
      return 0;
    }
    const saved = this.tabSelected?.[tab] ?? 0;
    return Math.max(0, Math.min(saved, Math.max(0, items.length - 1)));
  }

  switchTab(targetIndex) {
    if (this.tabSelected) this.tabSelected[this.tab] = this.selected;
    this.tabIndex = targetIndex;
    this.selected = this.getTabSelected(this.tab);
    this.filter = '';
  }

  async start() {
    if (!process.stdin.isTTY) {
      throw new Error('TUI requires an interactive TTY terminal.');
    }

    this.running = true;
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    // Enable bracketed paste mode (\x1b[?2004h) and clear screen
    process.stdout.write(C.hideCursor + C.clear + '\x1b[?2004h');

    process.on('SIGINT', () => this.exit());
    process.on('SIGTERM', () => this.exit());
    process.stdout.on('resize', () => {
      process.stdout.write(C.clear);
      this.render();
    });

    process.stdin.on('keypress', (str, key) => {
      this.handleKey(str, key);
    });

    await this.silentRefresh();
    if (this.tab === 'projects' && !this.hasInitializedProjectSelection) {
      this.selected = this.getTabSelected('projects');
      this.hasInitializedProjectSelection = true;
    }
    this.render();

    this.pollTimer = setInterval(async () => {
      if (this.running && !this.modal && !this.filtering && !this.isPasting) {
        await this.silentRefresh();
        this.render();
      }
    }, 4000);
  }

  exit() {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    try {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    } catch {}
    // Disable bracketed paste mode and restore cursor
    process.stdout.write('\x1b[?2004l' + C.showCursor + C.reset + '\n');
    process.exit(0);
  }

  getImpactLevel(app) {
    if (!app) return 'high';
    let diff = app.diff_summary;
    if (typeof diff === 'string') {
      try { diff = JSON.parse(diff); } catch { diff = {}; }
    }
    diff = diff || {};

    let files = app.files_changed;
    if (typeof files === 'string') {
      try { files = JSON.parse(files); } catch { files = []; }
    }
    files = files || [];

    // Check sensitive file patterns - always high impact
    const sensitive = [
      /\.env(\.|$)/i,
      /\.pem$/i,
      /\.key$/i,
      /id_rsa/i,
      /secret/i,
      /credential/i,
      /\.github\//i,
      /docker-compose/i,
      /production/i
    ];
    for (const f of files) {
      if (typeof f === 'string' && sensitive.some(pat => pat.test(f))) {
        return 'high';
      }
    }

    // Check commit message for high-impact keywords
    const msg = (app.proposed_commit_message || '').toLowerCase();
    if (msg.includes('breaking') || msg.includes('drop table') || msg.includes('drop database') || msg.includes('schema migration') || msg.includes('truncate')) {
      return 'high';
    }

    const delCount = diff.deleted || 0;
    // More than 15 files changed or more than 3 deleted is high impact
    if (files.length > 15 || delCount > 3) return 'high';

    // 5 or fewer files changed and 0 deleted is low impact
    if (files.length <= 5 && delCount === 0) return 'low';

    // Up to 15 files changed and up to 3 deletions is medium impact
    return 'medium';
  }

  isMediumImpact(app) {
    const lvl = this.getImpactLevel(app);
    return lvl === 'low' || lvl === 'medium';
  }

  isLessImpact(app) {
    return this.isMediumImpact(app);
  }

  async processAutoApprovals() {
    if (!this.autoApprove || this.isProcessingAutoApprove) return;
    this.isProcessingAutoApprove = true;
    try {
      const pending = [...this.approvals];
      const eligibleApps = pending.filter(a => this.isMediumImpact(a));
      for (const app of eligibleApps) {
        try {
          await this.decide(app.id, 'keep_local');
          const lvl = this.getImpactLevel(app);
          this.status = `Auto-approved ${app.id.slice(0, 8)} (keep_local, ${lvl} impact)`;
        } catch (e) {
          this.status = `Auto-approve failed for ${app.id.slice(0, 8)}: ${e.message}`;
        }
      }
    } finally {
      this.isProcessingAutoApprove = false;
    }
  }

  async silentRefresh() {
    try {
      this.activeSlug = this.getActiveProject ? this.getActiveProject() : this.activeSlug;
      const [hRes, pRes, aRes, tRes] = await Promise.allSettled([
        this.api('/health'),
        this.api('/projects'),
        this.api(`/approvals/pending?userId=${encodeURIComponent(process.env.USER || 'tui-user')}`),
        this.api('/tasks')
      ]);

      if (hRes.status === 'fulfilled') this.health = hRes.value;
      if (pRes.status === 'fulfilled') {
        this.projects = pRes.value || [];
        this.activeProject = this.projects.find(p => p.slug === this.activeSlug || p.id === this.activeSlug) || null;
        if (!this.hasInitializedProjectSelection && this.activeProject) {
          const actIdx = this.projects.findIndex(p => p.slug === this.activeSlug || p.id === this.activeSlug);
          if (actIdx !== -1) {
            this.tabSelected.projects = actIdx;
            if (this.tab === 'projects') {
              this.selected = actIdx;
            }
            this.hasInitializedProjectSelection = true;
          }
        }
      }
      if (aRes.status === 'fulfilled') {
        this.approvals = aRes.value || [];
        if (this.autoApprove && !this.isProcessingAutoApprove && this.approvals.length > 0) {
          await this.processAutoApprovals();
        }
      }
      if (tRes.status === 'fulfilled') this.tasks = (tRes.value || []).slice(0, 30);
    } catch (e) {
      this.status = `Network error: ${e.message}`;
    }
  }

  getFilteredItems() {
    const q = this.filter.trim().toLowerCase();
    if (this.tab === 'projects') {
      if (!q) return this.projects;
      return this.projects.filter(p => p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q));
    }
    if (this.tab === 'tasks') {
      let list = [...this.tasks];

      // Sort by status priority: 1. RUNNING/ACTIVE, 2. BLOCKED/REVIEW, 3. COMPLETED, 4. FAILED/CANCELLED
      const getPriority = (t) => {
        const st = (t.status || '').toLowerCase();
        const wf = (t.workflow_status || '').toLowerCase();
        if (st === 'running' || st === 'queued' || wf === 'verifying' || wf === 'auditing') return 1;
        if (st === 'blocked' || wf === 'blocked' || wf === 'awaiting_approval' || st === 'interrupted') return 2;
        if (st === 'completed' || wf === 'completed') return 3;
        return 4;
      };

      list.sort((a, b) => {
        const pa = getPriority(a);
        const pb = getPriority(b);
        if (pa !== pb) return pa - pb;
        return (b.created_at || '').localeCompare(a.created_at || '');
      });

      if (this.taskStatusFilter && this.taskStatusFilter !== 'ALL') {
        list = list.filter(t => {
          const p = getPriority(t);
          if (this.taskStatusFilter === 'RUNNING') return p === 1;
          if (this.taskStatusFilter === 'BLOCKED') return p === 2;
          if (this.taskStatusFilter === 'COMPLETED') return p === 3;
          if (this.taskStatusFilter === 'FAILED') return p === 4;
          return true;
        });
      }

      if (!q) return list;
      return list.filter(t => {
        const proj = this.projects.find(p => p.id === t.project_id)?.slug || t.project_id || '';
        return (t.prompt || '').toLowerCase().includes(q) ||
               t.id.toLowerCase().includes(q) ||
               (t.status || '').toLowerCase().includes(q) ||
               proj.toLowerCase().includes(q);
      });
    }
    if (this.tab === 'approvals') {
      if (!q) return this.approvals;
      return this.approvals.filter(a => a.id.toLowerCase().includes(q) || (a.project_id || '').toLowerCase().includes(q));
    }
    return [];
  }

  render() {
    if (!this.running) return;
    const cols = Math.max(70, process.stdout.columns || 80);
    const rows = Math.max(20, process.stdout.rows || 24);

    const out = [];

    // Header (Row 1-3)
    out.push(this.renderHeader(cols));

    // Calculate Panes Height
    const bodyHeight = Math.max(8, rows - 7);
    const isTasksTab = this.tab === 'tasks';
    const maxLeft = cols >= 105 ? 54 : 44;
    const leftWidth = Math.max(28, Math.min(maxLeft, Math.floor(cols * (isTasksTab ? 0.46 : 0.38))));
    const rightWidth = cols - leftWidth - 3; // 3 border chars

    const { leftLines, rightLines } = this.renderBodyPanes(leftWidth, rightWidth, bodyHeight);

    // Frame Borders
    const topBorder = `├${'─'.repeat(leftWidth)}┬${'─'.repeat(rightWidth)}┤`;
    const bottomBorder = `├${'─'.repeat(leftWidth)}┴${'─'.repeat(rightWidth)}┤`;

    out.push(topBorder);
    for (let i = 0; i < bodyHeight; i++) {
      const left = fit(leftLines[i] || '', leftWidth);
      const right = fit(rightLines[i] || '', rightWidth);
      out.push(`│${left}│${right}│`);
    }
    out.push(bottomBorder);

    // Footer & Status Bar
    out.push(this.renderFooter(cols));

    // Render modal screen or 2-pane screen
    const screen = this.modal ? this.renderModalScreen(cols, rows) : out.join('\n');
    process.stdout.write(C.home + screen);
  }

  renderHeader(cols) {
    const title = `${C.bold}${C.cyan} CodeOrchestrator ${C.reset}${C.dim}v1.0${C.reset}`;
    const healthBadge = this.health?.status === 'ok'
      ? `${C.green}● ONLINE${C.reset}`
      : `${C.red}✖ OFFLINE${C.reset}`;
    const activeText = this.activeSlug
      ? `${C.dim}Project:${C.reset} ${C.bold}${C.green}${this.activeSlug}${C.reset}`
      : `${C.yellow}No Active Project${C.reset}`;

    const rightInfo = `${activeText}  ${healthBadge} `;
    const fillTop = Math.max(0, cols - 2 - visibleLen(' CodeOrchestrator v1.0 ') - visibleLen(rightInfo));
    const line1 = `╭─${title}${'─'.repeat(fillTop)}${rightInfo}╮`;

    // Tab Bar (Row 2)
    const tabDefs = [
      { id: 'projects', label: `1. Projects (${this.projects.length})` },
      { id: 'tasks', label: `2. Tasks (${this.tasks.length})` },
      { id: 'approvals', label: `3. Approvals (${this.approvals.length})` },
      { id: 'system', label: '4. System' }
    ];

    const tabSegments = tabDefs.map((t, idx) => {
      const isSel = this.tabIndex === idx;
      if (isSel) {
        return `${C.bgBlue}${C.bold}${C.white} ${t.label} ${C.reset}`;
      }
      return `${C.dim} ${t.label} ${C.reset}`;
    }).join(' ');

    const line2 = `│ ${tabSegments}${fit('', Math.max(0, cols - 3 - visibleLen(tabSegments)))}│`;

    return `${line1}\n${line2}`;
  }

  renderBodyPanes(leftWidth, rightWidth, height) {
    const leftLines = [];
    const rightLines = [];
    const items = this.getFilteredItems();

    if (this.tab === 'projects') {
      if (this.tabSelected.projects === null && this.activeSlug) {
        const actIdx = items.findIndex(p => p.slug === this.activeSlug || p.id === this.activeSlug);
        if (actIdx !== -1) {
          this.selected = actIdx;
          this.tabSelected.projects = actIdx;
        }
      }
      if (items.length > 0 && this.selected >= items.length) {
        this.selected = items.length - 1;
      }

      leftLines.push(`${C.bold}${C.cyan}  PROJECT LIST${C.reset} ${this.filter ? `${C.yellow}(/${this.filter})${C.reset}` : ''}`);
      if (!items.length) {
        leftLines.push(`  ${C.dim}No matching projects${C.reset}`);
      } else {
        const maxVisible = Math.max(1, height - 1);
        let startIdx = 0;
        if (this.selected >= maxVisible) {
          startIdx = this.selected - maxVisible + 1;
        }
        items.slice(startIdx, startIdx + maxVisible).forEach((p, relIdx) => {
          const idx = startIdx + relIdx;
          const isSel = idx === this.selected;
          const isAct = p.slug === this.activeSlug || p.id === this.activeSlug;
          const cur = isSel ? `${C.cyan}▸${C.reset}` : ' ';
          const tag = isAct ? `${C.green}★${C.reset}` : ' ';
          const name = isSel ? `${C.bold}${C.white}${p.name}${C.reset}` : `${C.dim}${p.name}${C.reset}`;
          leftLines.push(` ${cur} ${tag} ${name}`);
        });
      }

      // Right Detail Pane
      const curProject = items[this.selected] || this.activeProject;
      if (curProject) {
        rightLines.push(`${C.bold}${C.yellow}  PROJECT DETAILS: ${curProject.name}${C.reset}`);
        rightLines.push(`  ${C.dim}Slug:${C.reset}       ${curProject.slug}`);
        rightLines.push(`  ${C.dim}ID:${C.reset}         ${curProject.id}`);
        rightLines.push(`  ${C.dim}Branch:${C.reset}     ${curProject.default_branch || 'main'}`);
        rightLines.push(`  ${C.dim}Model:${C.reset}      ${curProject.default_model || 'auto'}`);
        rightLines.push(`  ${C.dim}Workspace:${C.reset}  ${curProject.workspace_path || 'N/A'}`);
        rightLines.push(`  ${C.dim}Remote:${C.reset}     ${curProject.repo_url || curProject.repository_url || '(local only)'}`);
        rightLines.push('');
        rightLines.push(`${C.bold}  Interactive Actions:${C.reset}`);
        rightLines.push(`  ${C.green}[Enter]${C.reset}   Set as active project`);
        rightLines.push(`  ${C.cyan}[c / n]${C.reset}   Create new project`);
        rightLines.push(`  ${C.blue}[i]${C.reset}       Import existing directory`);
        rightLines.push(`  ${C.yellow}[v]${C.reset}       Validate workspace health`);
        rightLines.push(`  ${C.white}[g]${C.reset}       Configure git remote`);
        rightLines.push(`  ${C.magenta}[t / j]${C.reset}   Submit task / job`);
      } else {
        rightLines.push(`  ${C.dim}Select a project to inspect details${C.reset}`);
        rightLines.push(`  ${C.cyan}[c / n]${C.reset} Create new project`);
        rightLines.push(`  ${C.blue}[i]${C.reset}     Import existing directory`);
      }
    } else if (this.tab === 'tasks') {
      if (items.length > 0 && this.selected >= items.length) {
        this.selected = items.length - 1;
      }
      const runCount = this.tasks.filter(t => ['running', 'queued'].includes(t.status) || ['verifying', 'auditing'].includes(t.workflow_status)).length;
      const blockCount = this.tasks.filter(t => t.status === 'blocked' || t.workflow_status === 'blocked' || t.workflow_status === 'awaiting_approval').length;
      const doneCount = this.tasks.filter(t => t.status === 'completed').length;
      const failCount = this.tasks.filter(t => t.status === 'failed' || t.workflow_status === 'failed').length;

      const filterTag = this.taskStatusFilter && this.taskStatusFilter !== 'ALL' ? ` [${this.taskStatusFilter}]` : '';
      leftLines.push(`${C.bold}${C.cyan}  TASKS${filterTag}${C.reset} ${C.yellow}●${runCount}${C.reset} ${C.magenta}▲${blockCount}${C.reset} ${C.green}✔${doneCount}${C.reset} ${C.red}✖${failCount}${C.reset}`);

      const projColWidth = leftWidth >= 48 ? 12 : 9;
      const promptColWidth = Math.max(8, leftWidth - 11 - projColWidth - 3);

      leftLines.push(`  ${C.dim}STATUS | ${fit('PROJECT', projColWidth)} | PROMPT${C.reset}`);

      if (!items.length) {
        leftLines.push(`  ${C.dim}No tasks found matching filter${C.reset}`);
      } else {
        const maxVisible = Math.max(1, height - 2);
        let startIdx = 0;
        if (this.selected >= maxVisible) {
          startIdx = this.selected - maxVisible + 1;
        }
        items.slice(startIdx, startIdx + maxVisible).forEach((t, relIdx) => {
          const idx = startIdx + relIdx;
          const isSel = idx === this.selected;
          const cur = isSel ? `${C.cyan}▸${C.reset}` : ' ';

          const st = (t.status || '').toLowerCase();
          const wf = (t.workflow_status || '').toLowerCase();
          let badge;
          if (st === 'running') badge = `${C.yellow}● RUN ${C.reset}`;
          else if (st === 'queued') badge = `${C.cyan}○ QUE ${C.reset}`;
          else if (wf === 'verifying') badge = `${C.cyan}● VRFY${C.reset}`;
          else if (wf === 'auditing') badge = `${C.cyan}● AUDT${C.reset}`;
          else if (st === 'blocked' || wf === 'blocked') badge = `${C.magenta}▲ BLOK${C.reset}`;
          else if (wf === 'awaiting_approval') badge = `${C.blue}▲ APPR${C.reset}`;
          else if (st === 'completed') badge = `${C.green}✔ DONE${C.reset}`;
          else if (st === 'failed' || wf === 'failed') badge = `${C.red}✖ FAIL${C.reset}`;
          else if (st === 'cancelled') badge = `${C.gray}○ CANC${C.reset}`;
          else badge = `${C.gray}○ ${fit(st.slice(0, 4).toUpperCase(), 4)}${C.reset}`;

          const projSlug = this.projects.find(p => p.id === t.project_id)?.slug || (t.project_id ? t.project_id.slice(0, projColWidth) : 'general');
          const cleanPrompt = (t.prompt || '').replace(/\r?\n/g, ' ').trim();

          const pCol = fit(projSlug, projColWidth);
          const prCol = fit(cleanPrompt, promptColWidth);

          leftLines.push(`${cur} ${badge}| ${C.dim}${pCol}${C.reset} | ${isSel ? C.bold : ''}${prCol}${C.reset}`);
        });
      }

      const curTask = items[this.selected];
      if (curTask) {
        const st = (curTask.status || '').toLowerCase();
        const stColor = st === 'completed' ? C.green : (st === 'failed' ? C.red : (st === 'running' ? C.yellow : (st === 'blocked' ? C.magenta : C.white)));
        rightLines.push(`${C.bold}${C.yellow}  TASK INSPECTOR: ${curTask.id}${C.reset}`);
        rightLines.push(`  ${C.dim}Status:${C.reset}    ${stColor}${C.bold}${(curTask.status || '').toUpperCase()}${C.reset}`);
        const projSlug = this.projects.find(p => p.id === curTask.project_id)?.slug || curTask.project_id || 'N/A';
        rightLines.push(`  ${C.dim}Project:${C.reset}   ${C.cyan}${projSlug}${C.reset}`);
        rightLines.push(`  ${C.dim}Model:${C.reset}     ${curTask.model || 'auto'}`);
        rightLines.push(`  ${C.dim}Created:${C.reset}   ${curTask.created_at || 'unknown'}`);
        rightLines.push(`  ${C.dim}Workflow:${C.reset}  ${curTask.workflow_status || 'none'}`);
        if (curTask.error) {
          rightLines.push(`  ${C.dim}Error:${C.reset}     ${C.red}${fit(curTask.error.replace(/\r?\n/g, ' '), rightWidth - 14)}${C.reset}`);
        }
        rightLines.push('');
        rightLines.push(`${C.bold}  Interactive Actions:${C.reset}`);
        rightLines.push(`  ${C.green}[Enter/v]${C.reset} View full events & context log`);
        rightLines.push(`  ${C.blue}[s]${C.reset}       Cycle status filter (${this.taskStatusFilter || 'ALL'})`);
        if (curTask.status === 'running' || curTask.status === 'queued') {
          rightLines.push(`  ${C.red}[c]${C.reset}       Cancel running task`);
        }
        if (curTask.status === 'blocked' || curTask.workflow_status === 'blocked' || curTask.status === 'failed') {
          rightLines.push(`  ${C.yellow}[R]${C.reset}       Recover blocked/failed task`);
        }
        rightLines.push(`  ${C.cyan}[t]${C.reset}       New task`);
        rightLines.push('');
        rightLines.push(`${C.bold}  Prompt:${C.reset}`);
        const pLines = (curTask.prompt || '').split('\n').slice(0, 4);
        pLines.forEach(l => rightLines.push(`    ${C.italic}${fit(l, rightWidth - 6)}${C.reset}`));
      } else {
        rightLines.push(`  ${C.dim}Select a task to inspect full details${C.reset}`);
      }
    } else if (this.tab === 'approvals') {
      if (items.length > 0 && this.selected >= items.length) {
        this.selected = items.length - 1;
      }
      const autoTag = this.autoApprove ? `${C.green}[AUTO: ON (MEDIUM IMPACT)]${C.reset}` : `${C.dim}[AUTO: OFF]${C.reset}`;
      leftLines.push(`${C.bold}${C.cyan}  PENDING APPROVALS${C.reset} ${autoTag}`);
      if (!items.length) {
        leftLines.push(`  ${C.green}✔ All clean. No approvals pending.${C.reset}`);
      } else {
        const maxVisible = Math.max(1, height - 1);
        let startIdx = 0;
        if (this.selected >= maxVisible) {
          startIdx = this.selected - maxVisible + 1;
        }
        items.slice(startIdx, startIdx + maxVisible).forEach((a, relIdx) => {
          const idx = startIdx + relIdx;
          const isSel = idx === this.selected;
          const cur = isSel ? `${C.cyan}▸${C.reset}` : ' ';
          const lvl = this.getImpactLevel(a);
          let impactBadge = `${C.red}[HIGH]${C.reset}`;
          if (lvl === 'low') impactBadge = `${C.green}[LOW]${C.reset}`;
          else if (lvl === 'medium') impactBadge = `${C.yellow}[MED]${C.reset}`;
          leftLines.push(` ${cur} ${C.yellow}▲${C.reset} ${isSel ? C.bold : ''}${fit(a.id.slice(0, 14), 14)}...${C.reset} ${impactBadge}`);
        });
      }

      const curApp = items[this.selected];
      if (curApp) {
        const lvl = this.getImpactLevel(curApp);
        const isEligible = lvl === 'low' || lvl === 'medium';
        const impactDesc = isEligible
          ? `${lvl === 'low' ? C.green : C.yellow}${lvl.toUpperCase()} IMPACT (eligible for auto-approval)${C.reset}`
          : `${C.red}HIGH IMPACT (requires manual review)${C.reset}`;
        rightLines.push(`${C.bold}${C.yellow}  GATE 3 GIT APPROVAL REVIEW${C.reset}`);
        rightLines.push(`  ${C.dim}Approval ID:${C.reset} ${curApp.id}`);
        rightLines.push(`  ${C.dim}Project:${C.reset}     ${curApp.project_id}`);
        rightLines.push(`  ${C.dim}Target:${C.reset}      ${curApp.target_branch || 'main'} (base: ${curApp.reviewed_revision?.slice(0, 7) || 'HEAD'})`);
        rightLines.push(`  ${C.dim}Impact:${C.reset}      ${impactDesc}`);
        rightLines.push(`  ${C.dim}Message:${C.reset}     ${curApp.proposed_commit_message || '(No message)'}`);
        rightLines.push('');
        rightLines.push(`${C.bold}  Decide Operation:${C.reset}`);
        rightLines.push(`  ${this.autoApprove ? C.green : C.dim}[a] AUTO-APPROVE: ${this.autoApprove ? 'ON (Medium Impact: keep_local)' : 'OFF'}${C.reset}`);
        rightLines.push(`  ${C.green}[p] PUSH${C.reset}       Merge & push to upstream git remote`);
        rightLines.push(`  ${C.cyan}[k] KEEP LOCAL${C.reset} Preserve changes in workspace without push`);
        rightLines.push(`  ${C.red}[x] REJECT${C.reset}     Drop or invalidate changes`);
        rightLines.push(`  ${C.yellow}[d] DIFF${C.reset}       Inspect changed files & diff summary`);
      } else {
        rightLines.push(`  ${C.dim}No pending approval selected${C.reset}`);
        rightLines.push('');
        rightLines.push(`  ${this.autoApprove ? C.green : C.dim}[a] AUTO-APPROVE: ${this.autoApprove ? 'ON (Medium Impact: keep_local)' : 'OFF'}${C.reset}`);
      }
    } else if (this.tab === 'system') {
      leftLines.push(`${C.bold}${C.cyan}  SYSTEM METRICS${C.reset}`);
      if (this.health) {
        leftLines.push(`  PID:            ${this.health.pid}`);
        leftLines.push(`  Status:         ${this.health.status}`);
        leftLines.push(`  Running Tasks:  ${this.health.globalRunning}`);
        leftLines.push(`  Queue Depth:    ${this.health.queueDepth}`);
        leftLines.push(`  Disk Free:      ${this.health.diskFreeMB} MB`);
        leftLines.push(`  Disk Usage:     ${this.health.diskUsagePercent}%`);
        leftLines.push(`  Disk Gauge:`);
        leftLines.push(`  ${progressBar(this.health.diskUsagePercent, 14)}`);
      } else {
        leftLines.push(`  ${C.red}Server unreachable${C.reset}`);
      }

      rightLines.push(`${C.bold}${C.yellow}  ENVIRONMENT CONTEXT${C.reset}`);
      rightLines.push(`  ${C.dim}API URL:${C.reset}        ${process.env.ORCHESTRATOR_API_URL || 'http://127.0.0.1:4000'}`);
      rightLines.push(`  ${C.dim}User:${C.reset}           ${process.env.USER || 'orchestrator'}`);
      rightLines.push(`  ${C.dim}Active Project:${C.reset} ${this.activeSlug || '(none)'}`);
      if (this.activeProject) {
        rightLines.push(`  ${C.dim}Workspace:${C.reset}      ${this.activeProject.workspace_path}`);
      }
      rightLines.push('');
      rightLines.push(`${C.bold}  Interactive Shortcuts:${C.reset}`);
      rightLines.push(`  ${C.cyan}Tab / Shift-Tab${C.reset} : Next / Previous Tab`);
      rightLines.push(`  ${C.cyan}1, 2, 3, 4${C.reset}      : Direct Tab Jump`);
      rightLines.push(`  ${C.cyan}↑ / ↓ or j / k${C.reset}  : Item Selection`);
      rightLines.push(`  ${C.cyan}/${C.reset}              : Search Filter`);
      rightLines.push(`  ${C.cyan}c / n${C.reset}          : Create New Project`);
      rightLines.push(`  ${C.cyan}i${C.reset}              : Import Directory as Project`);
      rightLines.push(`  ${C.cyan}t / j${C.reset}          : Submit Task / Multi-Agent Job`);
      rightLines.push(`  ${C.cyan}v${C.reset}              : Validate Workspace or View Task Logs`);
      rightLines.push(`  ${C.cyan}c${C.reset}              : Cancel Running Task (in Tasks tab)`);
      rightLines.push(`  ${C.cyan}d${C.reset}              : View Approval Diff`);
      rightLines.push(`  ${C.cyan}p / k / x${C.reset}      : Approval Push / Keep / Reject`);
      rightLines.push(`  ${C.cyan}r${C.reset}              : Force Refresh Data`);
      rightLines.push(`  ${C.cyan}?${C.reset}              : Shortcuts Help Overlay`);
      rightLines.push(`  ${C.cyan}q${C.reset}              : Quit TUI`);
    }

    return { leftLines, rightLines };
  }

  renderFooter(cols) {
    let statusText = this.status;
    if (this.filtering) {
      statusText = `${C.yellow}Filter Query: ${C.white}${this.filter}█${C.reset}  ${C.dim}(Press Enter to confirm, Esc to clear)${C.reset}`;
    }

    const line1 = `│ ${fit(statusText, cols - 4)} │`;
    let hotkeys = '[Tab] Tab  [↑↓] Move  [Enter] Select  [/] Search  [t] Task  [?] Help  [q] Quit';
    if (this.tab === 'projects') hotkeys = '[Enter] Activate  [c/n] Create  [i] Import  [v] Validate  [g] Remote  [t] Task  [/] Search';
    if (this.tab === 'tasks') hotkeys = '[v/Enter] Logs  [s] Filter Status  [c] Cancel  [R] Recover  [t] New  [/] Search';
    if (this.tab === 'approvals') hotkeys = `[a] Auto-Approve (${this.autoApprove ? 'ON' : 'OFF'})  [p] Push  [k] Keep  [x] Reject  [d] Diff  [/] Search`;

    const maxHotkeysLen = Math.max(10, cols - 6);
    const dispHotkeys = visibleLen(hotkeys) > maxHotkeysLen ? hotkeys.slice(0, maxHotkeysLen - 1) + '…' : hotkeys;
    const hotkeysFill = Math.max(0, cols - 6 - visibleLen(dispHotkeys));
    const line2 = `╰─ ${C.dim}${dispHotkeys}${C.reset} ${'─'.repeat(hotkeysFill)}╯`;
    return `${line1}\n${line2}`;
  }

  renderFormLines(modalWidth = 68) {
    const lines = [];
    if (this.modal.subtitle) lines.push(this.modal.subtitle, '');
    const maxValLen = Math.max(10, modalWidth - 10);

    for (let i = 0; i < this.modal.fields.length; i++) {
      const f = this.modal.fields[i];
      const isActive = i === this.modal.activeField;
      const label = isActive ? `${C.bold}${C.yellow}${f.label}:${C.reset}` : `${C.dim}${f.label}:${C.reset}`;
      lines.push(label);
      const val = f.value || '';
      if (isActive) {
        const dispVal = val.length > maxValLen ? '…' + val.slice(val.length - maxValLen + 1) : val;
        lines.push(`${C.cyan}> ${C.bold}${C.white}${dispVal}█${C.reset}`);
      } else {
        const rawDisp = val || f.placeholder || '';
        const dispVal = rawDisp.length > maxValLen ? rawDisp.slice(0, maxValLen - 1) + '…' : rawDisp;
        lines.push(`  ${val ? C.white + dispVal + C.reset : C.dim + dispVal + C.reset}`);
      }
      lines.push('');
    }
    lines.push(`${C.dim}[Tab/↓] Switch Field   [Enter] Submit   [Esc] Cancel${C.reset}`);
    return lines;
  }

  renderInputLines(modalWidth = 68) {
    const lines = [
      this.modal.subtitle || `Target Project: ${this.activeSlug || 'None'}`,
      '',
      this.modal.label || 'Enter Prompt:'
    ];

    const contentWidth = Math.max(20, modalWidth - 6);
    const rawLines = (this.inputBuffer || '').split('\n');
    const wrapped = [];
    for (let i = 0; i < rawLines.length; i++) {
      const seg = rawLines[i];
      const isLast = i === rawLines.length - 1;
      const parts = wrapText(seg, contentWidth);
      for (let j = 0; j < parts.length; j++) {
        if (isLast && j === parts.length - 1) {
          wrapped.push(parts[j] + '█');
        } else {
          wrapped.push(parts[j]);
        }
      }
    }

    const maxPromptLines = 7;
    const displayLines = wrapped.length > maxPromptLines
      ? wrapped.slice(wrapped.length - maxPromptLines)
      : wrapped;

    for (const l of displayLines) {
      lines.push(`${C.cyan}> ${C.bold}${C.white}${l}${C.reset}`);
    }

    lines.push('');
    lines.push(`${C.dim}[Enter] Submit   [Esc] Cancel${C.reset}`);
    return lines;
  }

  renderModalScreen(cols, rows) {
    const out = [];

    // Header (Row 1-2)
    out.push(this.renderHeader(cols));

    const middleHeight = Math.max(8, rows - 5);
    const modalWidth = Math.min(68, cols - 6);
    const leftPad = Math.max(0, Math.floor((cols - modalWidth) / 2));
    const rightPad = Math.max(0, cols - modalWidth - leftPad);

    let content = [];
    if (this.modal.type === 'form') {
      content = this.renderFormLines(modalWidth);
    } else if (this.modal.type === 'input') {
      content = this.renderInputLines(modalWidth);
    } else {
      content = this.modal.lines || [];
    }

    const maxVisibleLines = Math.max(4, middleHeight - 4);
    const scrollOffset = this.modal.scrollOffset || 0;
    const visibleContent = content.slice(scrollOffset, scrollOffset + maxVisibleLines);
    const modalBoxHeight = visibleContent.length + 2;

    const padTop = Math.max(0, Math.floor((middleHeight - modalBoxHeight) / 2));
    const padBottom = Math.max(0, middleHeight - modalBoxHeight - padTop);

    // Background lines above modal
    for (let i = 0; i < padTop; i++) {
      out.push(' '.repeat(cols));
    }

    // Modal Top Border
    let titleText = ` ${this.modal.title} `;
    if (content.length > maxVisibleLines) {
      titleText += `[${scrollOffset + 1}-${Math.min(content.length, scrollOffset + maxVisibleLines)}/${content.length}] `;
    }
    const topFill = Math.max(0, modalWidth - 3 - visibleLen(titleText));
    const topBorder = `╭─${C.bold}${C.yellow}${titleText}${C.reset}${'─'.repeat(topFill)}╮`;
    out.push(' '.repeat(leftPad) + topBorder + ' '.repeat(rightPad));

    // Modal Content
    for (let i = 0; i < visibleContent.length; i++) {
      const lineText = fit(visibleContent[i] || '', modalWidth - 4);
      const boxLine = `│ ${lineText} │`;
      out.push(' '.repeat(leftPad) + boxLine + ' '.repeat(rightPad));
    }

    // Modal Bottom Border
    const botBorder = `╰${'─'.repeat(modalWidth - 2)}╯`;
    out.push(' '.repeat(leftPad) + botBorder + ' '.repeat(rightPad));

    // Background lines below modal
    for (let i = 0; i < padBottom; i++) {
      out.push(' '.repeat(cols));
    }

    // Footer & Status Bar
    out.push(this.renderFooter(cols));

    return out.join('\n');
  }

  async handleKey(str, key = {}) {
    if (!key) key = {};

    // Bracketed paste start / end detection
    if (key.name === 'paste-start') {
      this.isPasting = true;
      this.pasteBuffer = '';
      return;
    }

    if (key.name === 'paste-end') {
      this.isPasting = false;
      const pasted = this.pasteBuffer;
      this.pasteBuffer = '';
      if (!pasted) return;

      if (this.modal?.type === 'input') {
        this.inputBuffer += pasted;
        return this.render();
      }
      if (this.modal?.type === 'form') {
        const field = this.modal.fields[this.modal.activeField];
        if (field) {
          field.value = (field.value || '') + pasted.replace(/[\r\n]+/g, ' ');
        }
        return this.render();
      }
      if (this.filtering) {
        this.filter += pasted.replace(/[\r\n]+/g, '');
        this.selected = 0;
        return this.render();
      }
      return;
    }

    // Accumulate paste chunks while bracketed paste is active
    if (this.isPasting) {
      if (key.name === 'return' || str === '\r' || str === '\n') {
        this.pasteBuffer += '\n';
      } else if (str) {
        this.pasteBuffer += str;
      }
      return;
    }

    // Filter typing mode
    if (this.filtering) {
      if (key.name === 'escape') {
        this.filtering = false;
        this.filter = '';
        this.selected = 0;
        return this.render();
      }
      if (key.name === 'return') {
        this.filtering = false;
        return this.render();
      }
      if (key.name === 'backspace') {
        this.filter = this.filter.slice(0, -1);
        this.selected = 0;
        return this.render();
      }
      if (str && !key.ctrl && !key.meta) {
        this.filter += str.replace(/[\r\n]+/g, '');
        this.selected = 0;
        return this.render();
      }
      return;
    }

    // Modal dialog mode
    if (this.modal) {
      if (this.modal.type === 'confirm') {
        if (str === 'y' || str === 'Y' || key.name === 'return') {
          const cb = this.modal.onConfirm;
          this.modal = null;
          if (cb) cb();
          return;
        }
        if (str === 'n' || str === 'N' || key.name === 'escape') {
          this.modal = null;
          this.status = 'Action cancelled.';
          return this.render();
        }
        return;
      }

      if (this.modal.type === 'form') {
        const field = this.modal.fields[this.modal.activeField];
        if (key.name === 'escape') {
          this.modal = null;
          return this.render();
        }
        if (key.name === 'tab' || key.name === 'down') {
          this.modal.activeField = (this.modal.activeField + 1) % this.modal.fields.length;
          return this.render();
        }
        if (key.name === 'up' || (key.shift && key.name === 'tab')) {
          this.modal.activeField = (this.modal.activeField - 1 + this.modal.fields.length) % this.modal.fields.length;
          return this.render();
        }
        if (key.name === 'return') {
          const formData = {};
          for (const f of this.modal.fields) {
            formData[f.key] = (f.value || '').trim();
          }
          const cb = this.modal.onSubmit;
          this.modal = null;
          if (cb) cb(formData);
          return;
        }
        if (key.name === 'backspace') {
          field.value = (field.value || '').slice(0, -1);
          return this.render();
        }
        if (str && !key.ctrl && !key.meta) {
          field.value = (field.value || '') + str.replace(/[\r\n]+/g, ' ');
          return this.render();
        }
        return;
      }

      if (this.modal.type === 'input') {
        if (key.name === 'escape') {
          this.modal = null;
          return this.render();
        }
        if (key.name === 'return') {
          const val = this.inputBuffer.trim();
          const cb = this.modal.onInput;
          this.modal = null;
          if (cb) cb(val);
          return;
        }
        if (key.name === 'backspace') {
          this.inputBuffer = this.inputBuffer.slice(0, -1);
          return this.render();
        }
        if (str && !key.ctrl && !key.meta) {
          this.inputBuffer += str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          return this.render();
        }
        return;
      }

      // Scrollable Info modal
      if (key.name === 'up' || str === 'k') {
        if ((this.modal.scrollOffset || 0) > 0) {
          this.modal.scrollOffset--;
          return this.render();
        }
      }
      if (key.name === 'down' || str === 'j') {
        if ((this.modal.scrollOffset || 0) + 5 < (this.modal.lines || []).length) {
          this.modal.scrollOffset = (this.modal.scrollOffset || 0) + 1;
          return this.render();
        }
      }
      if (key.name === 'escape' || key.name === 'return' || key.name === 'q') {
        this.modal = null;
        return this.render();
      }
      return;
    }

    // Global exits
    if (key.ctrl && key.name === 'c') return this.exit();
    if (key.name === 'q') return this.exit();

    // Tab Navigation
    if (key.name === 'tab') {
      const nextIdx = (this.tabIndex + (key.shift ? -1 : 1) + 4) % 4;
      this.switchTab(nextIdx);
      return this.render();
    }
    if (str === '`') {
      const prevIdx = (this.tabIndex - 1 + 4) % 4;
      this.switchTab(prevIdx);
      return this.render();
    }
    if (str === '1') { this.switchTab(0); return this.render(); }
    if (str === '2') { this.switchTab(1); return this.render(); }
    if (str === '3') { this.switchTab(2); return this.render(); }
    if (str === '4') { this.switchTab(3); return this.render(); }

    // List Selection Navigation
    if (key.name === 'up' || (str === 'k' && this.tab !== 'approvals')) {
      const len = this.getFilteredItems().length;
      if (len > 0) {
        this.selected = (this.selected - 1 + len) % len;
        if (this.tabSelected) this.tabSelected[this.tab] = this.selected;
        return this.render();
      }
    }
    if (key.name === 'down' || str === 'j') {
      const len = this.getFilteredItems().length;
      if (len > 0) {
        this.selected = (this.selected + 1) % len;
        if (this.tabSelected) this.tabSelected[this.tab] = this.selected;
        return this.render();
      }
    }

    // Filter search trigger
    if (str === '/') {
      this.filtering = true;
      this.filter = '';
      return this.render();
    }

    // Help modal
    if (str === '?') {
      this.modal = {
        title: 'Keyboard Shortcuts',
        type: 'info',
        scrollOffset: 0,
        lines: [
          'Tab / `         : Next tab (Tab) / Previous tab (`)',
          '1, 2, 3, 4      : Jump to tab (Projects, Tasks, Approvals, Sys)',
          '↑/↓ or j/k      : Navigate items in list',
          'Enter           : Activate project (tab 1) / View task details (tab 2)',
          '/               : Instant search filter',
          'c / n           : Create new project form (tab 1)',
          'i               : Import existing directory as project (tab 1)',
          't               : Submit task modal',
          'j               : Submit multi-agent job modal',
          'v               : Validate workspace (tab 1) or View full logs (tab 2)',
          'c               : Cancel running task (tab 2)',
          'a               : Toggle Auto-Approve medium impact (tab 3)',
          'd               : View approval diff summary (tab 3)',
          'p / k / x       : Approval push / keep_local / reject (tab 3)',
          'r               : Force refresh data',
          'q / Ctrl-C      : Exit TUI'
        ]
      };
      return this.render();
    }

    // Refresh
    if (str === 'r') {
      this.status = 'Refreshing all data...';
      this.render();
      this.silentRefresh().then(() => {
        this.status = 'Data refreshed.';
        this.render();
      });
      return;
    }

    // Task & Job modals
    if (str === 't') return this.triggerTaskModal();
    if (str === 'j') return this.triggerJobModal();

    // Contextual Action: Enter
    if (key.name === 'return') return this.handleAction();

    // Projects: Create New Project (c or n)
    if (this.tab === 'projects' && (str === 'c' || str === 'n')) {
      return this.openCreateProjectModal();
    }

    // Projects: Import Existing Directory (i)
    if (this.tab === 'projects' && str === 'i') {
      return this.openImportProjectModal();
    }

    // Projects: Configure Git Remote (g)
    if (this.tab === 'projects' && str === 'g') {
      return this.openConfigureGitModal();
    }

    // Contextual Action: View / Validate
    if (str === 'v') {
      if (this.tab === 'projects') return this.validateWorkspace();
      if (this.tab === 'tasks') return this.viewTaskDetails();
    }

    // Tasks: Filter Status Cycle
    if (this.tab === 'tasks' && str === 's') {
      const filters = ['ALL', 'RUNNING', 'BLOCKED', 'COMPLETED', 'FAILED'];
      const nextIdx = (filters.indexOf(this.taskStatusFilter || 'ALL') + 1) % filters.length;
      this.taskStatusFilter = filters[nextIdx];
      this.selected = 0;
      this.status = `Task filter: ${this.taskStatusFilter}`;
      return this.render();
    }

    // Tasks: Recover Blocked or Failed Task
    if (this.tab === 'tasks' && (str === 'r' || str === 'R')) {
      const items = this.getFilteredItems();
      const curTask = items[this.selected];
      if (!curTask) return;
      return this.openConfirmModal(
        'Recover Task',
        `Re-run verification & recovery for task ${curTask.id.slice(0, 8)}?`,
        async () => {
          this.status = `Recovering task ${curTask.id}...`;
          this.render();
          try {
            await this.api(`/tasks/${curTask.id}/recover`, { method: 'POST' });
            this.status = `Task ${curTask.id.slice(0, 8)} recovery started.`;
            await this.silentRefresh();
          } catch (e) {
            this.status = `Recovery failed: ${e.message}`;
          }
          this.render();
        }
      );
    }

    // Tasks: Cancel Running Task
    if (this.tab === 'tasks' && str === 'c') {
      const items = this.getFilteredItems();
      const curTask = items[this.selected];
      if (!curTask) return;
      return this.openConfirmModal(
        'Cancel Task',
        `Cancel task ${curTask.id.slice(0, 8)}?`,
        async () => {
          this.status = `Cancelling task ${curTask.id}...`;
          this.render();
          try {
            await this.api(`/tasks/${curTask.id}/cancel`, { method: 'POST' });
            this.status = `Task ${curTask.id.slice(0, 8)} cancelled.`;
            await this.silentRefresh();
          } catch (e) {
            this.status = `Cancel failed: ${e.message}`;
          }
          this.render();
        }
      );
    }

    // Approvals: View Diff / Decide / Toggle Auto-Approve
    if (this.tab === 'approvals') {
      if (str === 'a' || str === 'A') {
        this.autoApprove = !this.autoApprove;
        this.status = `Auto-approve ${this.autoApprove ? 'ENABLED (Medium Impact: keep_local)' : 'DISABLED'}`;
        if (this.autoApprove) {
          await this.processAutoApprovals();
        }
        return this.render();
      }
      const items = this.getFilteredItems();
      const app = items[this.selected];
      if (app) {
        if (str === 'd') return this.viewApprovalDiff(app);
        if (str === 'p') return this.decide(app.id, 'push');
        if (str === 'k') return this.decide(app.id, 'keep_local');
        if (str === 'x') return this.decide(app.id, 'reject');
      }
    }
  }

  async handleAction() {
    const items = this.getFilteredItems();
    if (this.tab === 'projects' && items.length > 0) {
      const p = items[this.selected];
      if (p) {
        this.setActiveProject(p.slug);
        this.activeSlug = p.slug;
        this.activeProject = p;
        if (this.tabSelected) this.tabSelected.projects = this.selected;
        this.status = `Active project switched to: ${p.slug}`;
        this.render();
      }
    } else if (this.tab === 'tasks' && items.length > 0) {
      return this.viewTaskDetails();
    }
  }

  openCreateProjectModal() {
    this.openFormModal(
      'Create New Project',
      [
        { key: 'name', label: 'Project Name (required)', placeholder: 'e.g. ballo-auth' },
        { key: 'repoUrl', label: 'Git Remote URL (optional)', placeholder: 'e.g. https://github.com/org/repo' },
        { key: 'branch', label: 'Default Branch (optional)', placeholder: 'main' }
      ],
      async (data) => {
        if (!data.name) {
          this.status = 'Error: Project name is required.';
          return this.render();
        }
        this.status = `Creating project ${data.name}...`;
        this.render();
        try {
          const payload = {
            name: data.name,
            repoUrl: data.repoUrl || undefined,
            branch: data.branch || undefined
          };
          const res = await this.api('/projects', { method: 'POST', body: payload });
          this.status = `Project created: ${res.name} (${res.slug})`;
          this.setActiveProject(res.slug);
          this.activeSlug = res.slug;
          await this.silentRefresh();
          const idx = this.projects.findIndex(p => p.slug === res.slug);
          if (idx !== -1) {
            this.selected = idx;
            if (this.tabSelected) this.tabSelected.projects = idx;
          }
        } catch (e) {
          this.status = `Create failed: ${e.message}`;
        }
        this.render();
      }
    );
  }

  openImportProjectModal() {
    this.openFormModal(
      'Import Existing Directory',
      [
        { key: 'directory', label: 'Directory Path (required)', placeholder: 'e.g. /home/user/workspace/my-app' },
        { key: 'name', label: 'Project Name (optional)', placeholder: 'e.g. my-app' }
      ],
      async (data) => {
        if (!data.directory) {
          this.status = 'Error: Directory path is required.';
          return this.render();
        }
        this.status = `Importing directory ${data.directory}...`;
        this.render();
        try {
          const res = await this.api('/projects/import', { method: 'POST', body: data });
          this.status = `Project imported: ${res.name} (${res.slug})`;
          this.setActiveProject(res.slug);
          this.activeSlug = res.slug;
          await this.silentRefresh();
          const idx = this.projects.findIndex(p => p.slug === res.slug);
          if (idx !== -1) {
            this.selected = idx;
            if (this.tabSelected) this.tabSelected.projects = idx;
          }
        } catch (e) {
          this.status = `Import failed: ${e.message}`;
        }
        this.render();
      }
    );
  }

  openConfigureGitModal() {
    const items = this.getFilteredItems();
    const p = items[this.selected] || this.activeProject;
    if (!p) return;
    this.openFormModal(
      `Configure Git Remote: ${p.slug}`,
      [
        { key: 'repoUrl', label: 'Remote Repository URL (GitHub URL)', placeholder: 'e.g. https://github.com/lukman-ss/my-repo' },
        { key: 'defaultBranch', label: 'Default Branch (optional)', placeholder: p.default_branch || 'main' }
      ],
      async (data) => {
        if (!data.repoUrl) {
          this.status = 'Error: Remote URL is required.';
          return this.render();
        }
        this.status = `Configuring git remote for ${p.slug}...`;
        this.render();
        try {
          await this.api(`/projects/${p.id}/git/remote`, {
            method: 'POST',
            body: { repoUrl: data.repoUrl, defaultBranch: data.defaultBranch || undefined }
          });
          this.status = `Git remote configured for ${p.slug}`;
          await this.silentRefresh();
        } catch (e) {
          this.status = `Config failed: ${e.message}`;
        }
        this.render();
      }
    );
  }

  async validateWorkspace() {
    const items = this.getFilteredItems();
    const p = items[this.selected] || this.activeProject;
    if (!p) return;
    this.status = `Validating workspace for ${p.slug}...`;
    this.render();
    try {
      const [valRes, gitRes, proj] = await Promise.all([
        this.api(`/projects/${p.id}/validate`),
        this.api(`/projects/${p.id}/git/state`).catch(() => null),
        this.api(`/projects/${p.id}`).catch(() => p)
      ]);

      const isValid = valRes?.valid !== false && !valRes?.error;
      const statusBadge = isValid ? `${C.green}✔ VALID / HEALTHY${C.reset}` : `${C.red}✖ INVALID / BROKEN${C.reset}`;
      const gitState = gitRes?.gitState || 'UNKNOWN';

      const lines = [
        `Target Project:     ${proj.name} (${proj.slug})`,
        `Workspace Path:     ${proj.workspace_path || 'N/A'}`,
        `Overall Status:     ${statusBadge}`,
        `Detected Stack:     ${valRes?.stack || proj.metadata?.stack || 'Unknown'}`,
        `Git State:          ${C.yellow}${gitState}${C.reset}`,
        `Configured Remote:  ${proj.repo_url || proj.repository_url || '(none - local only)'}`,
        `Actual Remote:      ${valRes?.actualRemote || '(none)'}`,
        `Default Branch:     ${proj.default_branch || 'main'}`
      ];

      if (valRes?.mismatch) {
        lines.push('', `${C.red}${C.bold}⚠ Repository Mismatch Detected:${C.reset}`);
        lines.push(`  Expected: ${valRes.expectedRemote}`);
        lines.push(`  Actual:   ${valRes.actualRemote}`);
      }

      if (valRes?.error) {
        lines.push('', `${C.red}${C.bold}Error:${C.reset} ${valRes.error}`);
      } else {
        lines.push('', `${C.green}Workspace integrity verified. Workspace is ready for tasks.${C.reset}`);
      }

      lines.push('', '[g] Configure Remote   [Esc/Enter] Close');
      this.modal = { title: `Workspace Health: ${proj.slug}`, type: 'info', scrollOffset: 0, lines };
    } catch (e) {
      this.status = `Validation failed: ${e.message}`;
    }
    this.render();
  }

  async viewTaskDetails() {
    const items = this.getFilteredItems();
    const t = items[this.selected];
    if (!t) return;
    this.status = `Fetching events for task ${t.id.slice(0, 8)}...`;
    this.render();
    try {
      const events = await this.api(`/tasks/${t.id}/events`).catch(() => []);
      const lines = [
        `Task ID:   ${t.id}`,
        `Status:    ${(t.status || '').toUpperCase()}`,
        `Project:   ${t.project_id || 'N/A'}`,
        `Created:   ${t.created_at || 'N/A'}`,
        `Workflow:  ${t.workflow_status || 'N/A'}`,
        '',
        '--- PROMPT ---',
        ...(t.prompt || '').split('\n'),
        '',
        '--- SUMMARY ---',
        ...(t.summary || '(No summary)').split('\n'),
        '',
        '--- EVENTS STREAM ---'
      ];

      if (Array.isArray(events) && events.length > 0) {
        events.forEach(ev => {
          lines.push(`[${ev.sequence || 0}] ${ev.type || 'event'}: ${JSON.stringify(ev.data || {}).slice(0, 60)}`);
        });
      } else {
        lines.push('(No recorded event stream)');
      }

      if (t.error) {
        lines.push('', '--- ERROR ---', t.error);
      }

      lines.push('', '[↑/↓/j/k] Scroll   [Esc/Enter] Close');
      this.modal = { title: `Task Log: ${t.id.slice(0, 8)}`, type: 'info', scrollOffset: 0, lines };
    } catch (e) {
      this.status = `Failed to load details: ${e.message}`;
    }
    this.render();
  }

  viewApprovalDiff(app) {
    let diffSummary = {};
    let files = [];
    try { diffSummary = JSON.parse(app.diff_summary_json || '{}'); } catch {}
    try { files = JSON.parse(app.files_changed_json || '[]'); } catch {}

    const lines = [
      `Approval ID:     ${app.id}`,
      `Project ID:      ${app.project_id}`,
      `Target Branch:   ${app.target_branch || 'main'}`,
      `Base Revision:   ${app.reviewed_revision?.slice(0, 8) || 'HEAD'}`,
      `Commit Message:  ${app.proposed_commit_message || '(none)'}`,
      '',
      '--- DIFF STATS ---',
      `Files Added:     ${diffSummary.added ?? 0}`,
      `Files Modified:  ${diffSummary.modified ?? 0}`,
      `Files Deleted:   ${diffSummary.deleted ?? 0}`,
      '',
      '--- CHANGED FILES ---',
      ...(files.length ? files.map(f => `  • ${f}`) : ['  (None)']),
      '',
      '[p] Push   [k] Keep Local   [x] Reject   [Esc] Close'
    ];
    this.modal = { title: `Git Approval Diff: ${app.id.slice(0, 8)}`, type: 'info', scrollOffset: 0, lines };
    this.render();
  }

  async decide(approvalId, decision) {
    this.status = `Deciding approval ${approvalId} (${decision})...`;
    this.render();
    try {
      await this.api(`/approvals/${approvalId}/decide`, {
        method: 'POST',
        body: { decision, userId: process.env.USER || 'tui-user' }
      });
      this.status = `Approval ${approvalId} decided: ${decision}`;
      await this.silentRefresh();
      this.selected = 0;
      if (this.tabSelected) this.tabSelected.approvals = 0;
    } catch (e) {
      this.status = `Decision failed: ${e.message}`;
    }
    this.render();
  }

  triggerTaskModal() {
    return this.openPromptModal(
      'Submit Task',
      { label: 'Enter Task Prompt:' },
      async (prompt) => {
        if (!prompt) {
          this.status = 'Task cancelled (empty prompt).';
          return this.render();
        }
        if (!this.activeProject) {
          this.status = 'Error: No active project selected. Select one first.';
          return this.render();
        }
        this.status = `Submitting task to ${this.activeProject.slug}...`;
        this.render();
        try {
          const res = await this.api(`/projects/${this.activeProject.id}/tasks`, {
            method: 'POST',
            body: { prompt }
          });
          this.status = `Task submitted: ${res.id}`;
          await this.silentRefresh();
          this.switchTab(1);
          this.selected = 0;
          if (this.tabSelected) this.tabSelected.tasks = 0;
        } catch (e) {
          this.status = `Task failed: ${e.message}`;
        }
        this.render();
      }
    );
  }

  triggerJobModal() {
    return this.openPromptModal(
      'Submit Multi-Agent Job',
      { label: 'Enter Architecture Specification / Requirements:' },
      async (prompt) => {
        if (!prompt) return this.render();
        if (!this.activeProject) {
          this.status = 'Error: No active project selected.';
          return this.render();
        }
        this.status = `Submitting job to ${this.activeProject.slug}...`;
        this.render();
        try {
          const res = await this.api('/jobs', {
            method: 'POST',
            body: { project_id: this.activeProject.id, prompt }
          });
          this.status = `Job scheduled: ${res.id}`;
          await this.silentRefresh();
        } catch (e) {
          this.status = `Job failed: ${e.message}`;
        }
        this.render();
      }
    );
  }

  openPromptModal(title, { label = 'Enter Prompt:', subtitle = '' } = {}, onInput) {
    this.inputBuffer = '';
    this.modal = {
      title,
      type: 'input',
      label,
      subtitle: subtitle || `Target Project: ${this.activeSlug || 'None'}`,
      onInput
    };
    this.render();
  }

  openFormModal(title, fields, onSubmit) {
    this.modal = {
      title,
      type: 'form',
      fields: fields.map(f => ({ ...f, value: f.value || '' })),
      activeField: 0,
      onSubmit
    };
    this.render();
  }

  openConfirmModal(title, question, onConfirm) {
    this.modal = {
      title,
      type: 'confirm',
      lines: [
        question,
        '',
        `${C.bold}[y] Confirm${C.reset}    ${C.dim}[n/Esc] Cancel${C.reset}`
      ],
      onConfirm
    };
    this.render();
  }
}

export function launchTui(deps) {
  const ui = new TerminalUi(deps);
  return ui.start();
}
