import { dbGet, dbGetOne } from '../database/db.js';
import { getGlobalRunning, getDispatchQueue, getDiskStats } from '../services/task-queue.js';
import { KnowledgeService } from '../services/knowledge-service.js';
import { ModelRouter } from '../services/model-router.js';

export default async function dashboardRoutes(app) {
  // Prometheus metrics endpoint
  app.get('/metrics', async (req, reply) => {
    const stats = getDiskStats();
    const diskAvailableBytes = (stats.availableMB || 0) * 1024 * 1024;
    const diskUsagePct = stats.usePercent || 0;
    const activeTasks = getGlobalRunning();
    const queueDepth = getDispatchQueue().length;
    const mem = process.memoryUsage();

    const taskCounts = dbGet("SELECT status, COUNT(*) as count FROM tasks GROUP BY status");
    const jobCounts = dbGet("SELECT status, COUNT(*) as count FROM jobs GROUP BY status");
    const approvalCounts = dbGet("SELECT status, COUNT(*) as count FROM git_approval_requests GROUP BY status");
    const modelUsageRows = dbGet("SELECT model, SUM(input_tokens) as input_toks, SUM(output_tokens) as output_toks, SUM(total_tokens) as total_toks, SUM(estimated_cost_usd) as total_cost FROM model_usage GROUP BY model");
    const budgetRows = dbGet("SELECT scope, scope_id, max_tokens, consumed_tokens, status FROM budget_allocations");

    const lines = [
      '# HELP orchestrator_uptime_seconds Process uptime in seconds',
      '# TYPE orchestrator_uptime_seconds gauge',
      `orchestrator_uptime_seconds ${Math.floor(process.uptime())}`,
      '',
      '# HELP orchestrator_memory_heap_bytes Process heap memory usage in bytes',
      '# TYPE orchestrator_memory_heap_bytes gauge',
      `orchestrator_memory_heap_bytes ${mem.heapUsed}`,
      '',
      '# HELP orchestrator_disk_available_bytes Free disk space in bytes',
      '# TYPE orchestrator_disk_available_bytes gauge',
      `orchestrator_disk_available_bytes ${diskAvailableBytes}`,
      '',
      '# HELP orchestrator_disk_usage_percent Disk space usage percentage',
      '# TYPE orchestrator_disk_usage_percent gauge',
      `orchestrator_disk_usage_percent ${diskUsagePct}`,
      '',
      '# HELP orchestrator_active_tasks Currently executing tasks',
      '# TYPE orchestrator_active_tasks gauge',
      `orchestrator_active_tasks ${activeTasks}`,
      '',
      '# HELP orchestrator_queue_depth Pending tasks waiting in queue',
      '# TYPE orchestrator_queue_depth gauge',
      `orchestrator_queue_depth ${queueDepth}`,
      '',
      '# HELP orchestrator_tasks_total Total tasks by terminal or current status',
      '# TYPE orchestrator_tasks_total counter'
    ];

    for (const row of taskCounts) {
      lines.push(`orchestrator_tasks_total{status="${row.status}"} ${row.count}`);
    }

    lines.push(
      '',
      '# HELP orchestrator_jobs_total Total multi-agent jobs by status',
      '# TYPE orchestrator_jobs_total counter'
    );
    for (const row of jobCounts) {
      lines.push(`orchestrator_jobs_total{status="${row.status}"} ${row.count}`);
    }

    lines.push(
      '',
      '# HELP orchestrator_approvals_total Git approval requests by status',
      '# TYPE orchestrator_approvals_total counter'
    );
    for (const row of approvalCounts) {
      lines.push(`orchestrator_approvals_total{status="${row.status}"} ${row.count}`);
    }

    lines.push(
      '',
      '# HELP orchestrator_model_tokens_total Total tokens consumed by model',
      '# TYPE orchestrator_model_tokens_total counter'
    );
    for (const row of modelUsageRows) {
      lines.push(`orchestrator_model_tokens_total{model="${row.model}",type="input"} ${row.input_toks || 0}`);
      lines.push(`orchestrator_model_tokens_total{model="${row.model}",type="output"} ${row.output_toks || 0}`);
      lines.push(`orchestrator_model_tokens_total{model="${row.model}",type="total"} ${row.total_toks || 0}`);
    }

    lines.push(
      '',
      '# HELP orchestrator_budget_tokens Budget tokens allocated and consumed',
      '# TYPE orchestrator_budget_tokens gauge'
    );
    for (const b of budgetRows) {
      const scopeLabel = `scope="${b.scope}",scope_id="${b.scope_id || 'global'}"`;
      lines.push(`orchestrator_budget_tokens{${scopeLabel},type="max"} ${b.max_tokens || 0}`);
      lines.push(`orchestrator_budget_tokens{${scopeLabel},type="consumed"} ${b.consumed_tokens || 0}`);
    }

    reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8').send(lines.join('\n') + '\n');
  });

  // Authoritative Web Dashboard
  app.get('/dashboard', async (req, reply) => {
    const stats = getDiskStats();
    const activeTasks = getGlobalRunning();
    const queueDepth = getDispatchQueue().length;
    const uptimeHrs = (process.uptime() / 3600).toFixed(1);

    const pendingApprovals = dbGet("SELECT * FROM git_approval_requests WHERE status = 'pending' ORDER BY created_at DESC LIMIT 10");
    const recentTasks = dbGet("SELECT id, project_id, status, execution_status, workflow_status, created_at FROM tasks ORDER BY created_at DESC LIMIT 10");
    const usageAggregate = ModelRouter.getAggregateUsage();
    const knowledgeStats = dbGet("SELECT scope, classification, COUNT(*) as cnt FROM knowledge_entries GROUP BY scope, classification");
    const budgetList = dbGet("SELECT * FROM budget_allocations ORDER BY updated_at DESC LIMIT 10");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CodeOrchestrator Operational Dashboard</title>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --heading: #f0f6fc;
      --accent: #58a6ff;
      --success: #3fb950;
      --warning: #d29922;
      --danger: #f85149;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      background-color: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 24px;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border);
      padding-bottom: 16px;
      margin-bottom: 24px;
    }
    h1, h2, h3 { color: var(--heading); margin: 0 0 12px 0; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .card {
      background-color: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px;
    }
    .stat-label { font-size: 12px; text-transform: uppercase; color: #8b949e; margin-bottom: 4px; }
    .stat-val { font-size: 24px; font-weight: 600; color: var(--heading); }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
    }
    .badge-pass { background: rgba(63, 185, 80, 0.2); color: var(--success); }
    .badge-warn { background: rgba(210, 153, 34, 0.2); color: var(--warning); }
    .badge-fail { background: rgba(248, 81, 73, 0.2); color: var(--danger); }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); }
    th { color: #8b949e; font-weight: 600; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { font-family: monospace; background: rgba(110,118,129,0.4); padding: 2px 4px; border-radius: 4px; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>CodeOrchestrator Operational Dashboard</h1>
      <span style="color: #8b949e; font-size: 13px;">Authoritative SQLite & Runtime Telemetry</span>
    </div>
    <div>
      <a href="/metrics" style="margin-right: 16px;">Prometheus /metrics</a>
      <a href="/health">Health Check</a>
    </div>
  </header>

  <div class="grid">
    <div class="card">
      <div class="stat-label">System Uptime</div>
      <div class="stat-val">${uptimeHrs} hrs</div>
      <div style="color: #8b949e; font-size: 12px; margin-top: 4px;">PID: ${process.pid} (Node ${process.version})</div>
    </div>
    <div class="card">
      <div class="stat-label">Active Workers</div>
      <div class="stat-val">${activeTasks}</div>
      <div style="color: #8b949e; font-size: 12px; margin-top: 4px;">Queue Depth: ${queueDepth}</div>
    </div>
    <div class="card">
      <div class="stat-label">Disk Free Space</div>
      <div class="stat-val">${stats.availableMB} MB</div>
      <div style="color: #8b949e; font-size: 12px; margin-top: 4px;">Usage: ${stats.usePercent}%</div>
    </div>
    <div class="card">
      <div class="stat-label">Total Model Tokens</div>
      <div class="stat-val">${(usageAggregate.totalTokens || 0).toLocaleString()}</div>
      <div style="color: #8b949e; font-size: 12px; margin-top: 4px;">Calls: ${usageAggregate.callsCount} | Cost: $${(usageAggregate.totalCostUsd || 0).toFixed(4)}</div>
    </div>
  </div>

  <div class="card" style="margin-bottom: 24px;">
    <h2>Pending Git Approvals (${pendingApprovals.length})</h2>
    ${pendingApprovals.length === 0 ? '<p style="color: #8b949e;">No Git operations awaiting human approval.</p>' : `
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Project</th>
          <th>Branch</th>
          <th>Revision</th>
          <th>Created</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${pendingApprovals.map(a => `
          <tr>
            <td><code>${a.id.slice(0, 8)}</code></td>
            <td><code>${a.project_id ? a.project_id.slice(0, 8) : 'N/A'}</code></td>
            <td>${a.target_branch || 'main'}</td>
            <td><code>${(a.reviewed_revision || 'HEAD').slice(0, 7)}</code></td>
            <td>${a.created_at}</td>
            <td><span class="badge badge-warn">${a.status}</span></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    `}
  </div>

  <div class="card" style="margin-bottom: 24px;">
    <h2>Recent Task Executions</h2>
    <table>
      <thead>
        <tr>
          <th>Task ID</th>
          <th>Project ID</th>
          <th>Status</th>
          <th>Execution</th>
          <th>Workflow Gate</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        ${recentTasks.map(t => `
          <tr>
            <td><code>${t.id.slice(0, 8)}</code></td>
            <td><code>${t.project_id ? t.project_id.slice(0, 8) : 'standalone'}</code></td>
            <td><span class="badge ${t.status === 'completed' ? 'badge-pass' : (t.status === 'failed' ? 'badge-fail' : 'badge-warn')}">${t.status}</span></td>
            <td>${t.execution_status || '-'}</td>
            <td>${t.workflow_status || '-'}</td>
            <td>${t.created_at}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Token Budget Allocations</h2>
      ${budgetList.length === 0 ? '<p style="color: #8b949e;">No specific budget allocations active.</p>' : `
      <table>
        <thead><tr><th>Scope</th><th>Scope ID</th><th>Consumed / Max</th><th>Status</th></tr></thead>
        <tbody>
          ${budgetList.map(b => `
            <tr>
              <td>${b.scope}</td>
              <td><code>${b.scope_id ? b.scope_id.slice(0, 8) : 'global'}</code></td>
              <td>${(b.consumed_tokens || 0).toLocaleString()} / ${(b.max_tokens || 0).toLocaleString()}</td>
              <td><span class="badge ${b.status === 'active' ? 'badge-pass' : 'badge-fail'}">${b.status}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      `}
    </div>

    <div class="card">
      <h2>Knowledge Entries</h2>
      ${knowledgeStats.length === 0 ? '<p style="color: #8b949e;">No persistent knowledge entries stored.</p>' : `
      <table>
        <thead><tr><th>Scope</th><th>Classification</th><th>Count</th></tr></thead>
        <tbody>
          ${knowledgeStats.map(k => `
            <tr><td>${k.scope}</td><td>${k.classification}</td><td><strong>${k.cnt}</strong></td></tr>
          `).join('')}
        </tbody>
      </table>
      `}
    </div>
  </div>
</body>
</html>`;

    reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  });

  // REST endpoints for Knowledge Management
  app.get('/api/knowledge', async (req, reply) => {
    try {
      const items = KnowledgeService.listEntries(req.query || {});
      reply.send(items);
    } catch (err) {
      reply.code(400).send({ error: err.message });
    }
  });

  app.post('/api/knowledge', async (req, reply) => {
    try {
      const item = KnowledgeService.createEntry(req.body || {});
      reply.code(201).send(item);
    } catch (err) {
      reply.code(400).send({ error: err.message });
    }
  });

  // REST endpoints for Model Router & Budget
  app.get('/api/models/usage', async (req, reply) => {
    try {
      const agg = ModelRouter.getAggregateUsage(req.query || {});
      reply.send(agg);
    } catch (err) {
      reply.code(500).send({ error: err.message });
    }
  });

  app.post('/api/models/budget', async (req, reply) => {
    try {
      const res = ModelRouter.setBudget(req.body || {});
      reply.send(res);
    } catch (err) {
      reply.code(400).send({ error: err.message });
    }
  });

  // REST endpoints for Autonomous Model Intelligence
  app.get('/api/models/registry', async (req, reply) => {
    try {
      const models = dbGet('SELECT * FROM model_registry ORDER BY provider, id');
      reply.send(models.map(m => {
        let supportedVariants = [];
        let capabilities = [];
        try { supportedVariants = JSON.parse(m.supported_variants_json || '[]'); } catch {}
        try { capabilities = JSON.parse(m.capability_metadata_json || '[]'); } catch {}
        return {
          id: m.id,
          provider: m.provider,
          displayName: m.display_name,
          availabilityStatus: m.availability_status,
          toolSupport: Boolean(m.tool_support),
          reasoningSupport: Boolean(m.reasoning_support),
          supportedVariants,
          contextLimit: m.context_limit,
          outputLimit: m.output_limit,
          capabilities,
          healthStatus: m.health_status,
          lastCheckedAt: m.last_checked_at
        };
      }));
    } catch (err) {
      reply.code(500).send({ error: err.message });
    }
  });

  app.get('/api/models/decisions', async (req, reply) => {
    try {
      const limit = Number(req.query?.limit || 50);
      const decisions = dbGet('SELECT * FROM model_routing_decisions ORDER BY created_at DESC LIMIT ?', [limit]);
      reply.send(decisions);
    } catch (err) {
      reply.code(500).send({ error: err.message });
    }
  });

  app.get('/api/models/failovers', async (req, reply) => {
    try {
      const limit = Number(req.query?.limit || 50);
      const failovers = dbGet('SELECT * FROM model_failover_events ORDER BY created_at DESC LIMIT ?', [limit]);
      reply.send(failovers);
    } catch (err) {
      reply.code(500).send({ error: err.message });
    }
  });

  app.get('/api/models/performance', async (req, reply) => {
    try {
      const history = dbGet('SELECT * FROM model_performance_history ORDER BY total_executions DESC');
      reply.send(history);
    } catch (err) {
      reply.code(500).send({ error: err.message });
    }
  });

  app.get('/api/models/policies', async (req, reply) => {
    try {
      const policies = dbGet('SELECT * FROM model_policies ORDER BY category');
      reply.send(policies);
    } catch (err) {
      reply.code(500).send({ error: err.message });
    }
  });
}
