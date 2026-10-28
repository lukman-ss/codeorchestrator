import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DATABASE_PATH } from '../config.js';
import { migrations as allMigrations, currentSchemaVersion } from './migrations.js';

mkdirSync(dirname(DATABASE_PATH), { recursive: true });

const db = new Database(DATABASE_PATH, { timeout: 5000 });
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const initMigrations = () => {
  db.prepare('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT DEFAULT (datetime(\'now\')))').run();
  const current = db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v || 0;
  if (current < currentSchemaVersion) {
    for (let i = current; i < currentSchemaVersion; i++) {
      const m = allMigrations[i];
      if (m) db.exec(m);
    }
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(currentSchemaVersion);
  }
};

const baseTables = [
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    workspace_path TEXT NOT NULL UNIQUE,
    description TEXT,
    repo_url TEXT,
    repository_url TEXT,
    default_branch TEXT,
    default_model TEXT DEFAULT '9router/ayce-combo',
    repository_provider TEXT,
    creator_user_id TEXT,
    is_test INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    opencode_session_id TEXT,
    session_type TEXT NOT NULL DEFAULT 'project' CHECK(session_type IN ('standalone','project')),
    title TEXT,
    model TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('created','active','idle','interrupted','closed')),
    user_id TEXT,
    runtime_path TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK((session_type = 'standalone' AND project_id IS NULL) OR (session_type = 'project' AND project_id IS NOT NULL))
  )`,
  `CREATE TABLE IF NOT EXISTS session_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
    content TEXT NOT NULL,
    opencode_session_id TEXT,
    metadata_json TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    prompt TEXT NOT NULL,
    model TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','blocked','cancelled','interrupted')),
    pid INTEGER,
    exit_code INTEGER,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(task_id, sequence)
  )`,
  `CREATE TABLE IF NOT EXISTS project_operations (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'create',
    status TEXT NOT NULL CHECK(status IN ('pending','validating','creating','cloning','registering','completed','failed')),
    params_json TEXT NOT NULL,
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`
];

const ensureIndexes = () => {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_type ON sessions(session_type);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_projects_test ON projects(is_test);
    CREATE INDEX IF NOT EXISTS idx_project_operations_status ON project_operations(status);
    CREATE INDEX IF NOT EXISTS idx_model_registry_health ON model_registry(health_status, availability_status);
    CREATE INDEX IF NOT EXISTS idx_routing_decisions_task ON model_routing_decisions(task_id);
    CREATE INDEX IF NOT EXISTS idx_routing_decisions_project ON model_routing_decisions(project_id);
    CREATE INDEX IF NOT EXISTS idx_exec_attempts_task ON model_execution_attempts(task_id);
    CREATE INDEX IF NOT EXISTS idx_failover_events_task ON model_failover_events(task_id);
    CREATE INDEX IF NOT EXISTS idx_perf_history_model ON model_performance_history(model_id, category);
  `);
};

export const init = () => {
  const sessionCols = db.prepare('PRAGMA table_info(sessions)').all();
  if (sessionCols.length > 0) {
    const hasSessionType = sessionCols.some(c => c.name === 'session_type');
    const projCol = sessionCols.find(c => c.name === 'project_id');
    if (!hasSessionType || (projCol && projCol.notnull === 1)) {
      db.pragma('foreign_keys = OFF');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE sessions_new (
            id TEXT PRIMARY KEY,
            project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
            opencode_session_id TEXT,
            session_type TEXT NOT NULL DEFAULT 'project' CHECK(session_type IN ('standalone','project')),
            title TEXT,
            model TEXT,
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('created','active','idle','interrupted','closed')),
            user_id TEXT,
            runtime_path TEXT,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            CHECK((session_type = 'standalone' AND project_id IS NULL) OR (session_type = 'project' AND project_id IS NOT NULL))
          );
          INSERT INTO sessions_new (
            id, project_id, opencode_session_id, session_type, title, model, status, metadata_json, created_at, updated_at
          )
          SELECT
            id, project_id, opencode_session_id, 'project' AS session_type, title, model, 'active' AS status, '{}' AS metadata_json, created_at, updated_at
          FROM sessions;
          DROP TABLE sessions;
          ALTER TABLE sessions_new RENAME TO sessions;
        `);
      })();
      db.pragma('foreign_keys = ON');
    }
  }

  const tx = db.transaction(() => {
    for (const sql of baseTables) db.exec(sql);
  });
  tx();

  const projectCols = db.prepare('PRAGMA table_info(projects)').all();
  if (projectCols.length > 0) {
    const colNames = new Set(projectCols.map(c => c.name));
    if (!colNames.has('description')) db.exec('ALTER TABLE projects ADD COLUMN description TEXT;');
    if (!colNames.has('repository_url')) db.exec('ALTER TABLE projects ADD COLUMN repository_url TEXT;');
    if (!colNames.has('default_branch')) db.exec('ALTER TABLE projects ADD COLUMN default_branch TEXT;');
    if (!colNames.has('repository_provider')) db.exec('ALTER TABLE projects ADD COLUMN repository_provider TEXT;');
    if (!colNames.has('creator_user_id')) db.exec('ALTER TABLE projects ADD COLUMN creator_user_id TEXT;');
    db.exec("UPDATE projects SET repository_url = repo_url WHERE repository_url IS NULL AND repo_url IS NOT NULL;");
  }

  const taskCols = db.prepare('PRAGMA table_info(tasks)').all();
  if (taskCols.length > 0) {
    const colNames = new Set(taskCols.map(c => c.name));
    if (!colNames.has('workflow_status')) db.exec("ALTER TABLE tasks ADD COLUMN workflow_status TEXT DEFAULT 'queued';");
    if (!colNames.has('execution_status')) db.exec("ALTER TABLE tasks ADD COLUMN execution_status TEXT DEFAULT 'queued';");
  }

  const jobCols = db.prepare('PRAGMA table_info(jobs)').all();
  if (jobCols.length > 0) {
    const colNames = new Set(jobCols.map(c => c.name));
    if (!colNames.has('workflow_status')) db.exec("ALTER TABLE jobs ADD COLUMN workflow_status TEXT DEFAULT 'pending';");
    if (!colNames.has('execution_status')) db.exec("ALTER TABLE jobs ADD COLUMN execution_status TEXT DEFAULT 'pending';");
  }

  try {
    const policyCols = db.prepare('PRAGMA table_info(model_policies)').all();
    if (policyCols.length > 0) {
      const colNames = new Set(policyCols.map(c => c.name));
      if (!colNames.has('routing_mode')) db.exec("ALTER TABLE model_policies ADD COLUMN routing_mode TEXT DEFAULT 'auto';");
      if (!colNames.has('preferred_effort')) db.exec("ALTER TABLE model_policies ADD COLUMN preferred_effort TEXT DEFAULT 'medium';");
      if (!colNames.has('max_retries')) db.exec("ALTER TABLE model_policies ADD COLUMN max_retries INTEGER DEFAULT 2;");
      if (!colNames.has('max_model_switches')) db.exec("ALTER TABLE model_policies ADD COLUMN max_model_switches INTEGER DEFAULT 2;");
    }
  } catch {}

  try {
    const appCols = db.prepare('PRAGMA table_info(git_approval_requests)').all();
    if (appCols.length > 0) {
      const colNames = new Set(appCols.map(c => c.name));
      if (!colNames.has('discord_message_id')) db.exec('ALTER TABLE git_approval_requests ADD COLUMN discord_message_id TEXT;');
      if (!colNames.has('discord_channel_id')) db.exec('ALTER TABLE git_approval_requests ADD COLUMN discord_channel_id TEXT;');
      if (!colNames.has('pr_url')) db.exec('ALTER TABLE git_approval_requests ADD COLUMN pr_url TEXT;');
      if (!colNames.has('pr_number')) db.exec('ALTER TABLE git_approval_requests ADD COLUMN pr_number INTEGER;');
    }
  } catch {}

  try {
    const taskSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get()?.sql || '';
    if (taskSql && !taskSql.includes("'blocked'")) {
      db.pragma('foreign_keys = OFF');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE tasks_new (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
            prompt TEXT NOT NULL,
            model TEXT,
            status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','blocked','cancelled','interrupted')),
            pid INTEGER,
            exit_code INTEGER,
            error TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            started_at TEXT,
            finished_at TEXT,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            workflow_status TEXT DEFAULT 'queued',
            execution_status TEXT DEFAULT 'queued'
          );
          INSERT INTO tasks_new SELECT id, project_id, session_id, prompt, model, status, pid, exit_code, error, created_at, started_at, finished_at, updated_at, workflow_status, execution_status FROM tasks;
          DROP TABLE tasks;
          ALTER TABLE tasks_new RENAME TO tasks;
          CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
          CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        `);
      })();
      db.pragma('foreign_keys = ON');
    }
  } catch (err) {
    db.pragma('foreign_keys = ON');
  }

  try {
    const decSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='git_approval_decisions'").get()?.sql || '';
    if (decSql && !decSql.includes('create_pr')) {
      db.pragma('foreign_keys = OFF');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE git_approval_requests_new (
            id TEXT PRIMARY KEY,
            task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
            job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            repository_identity TEXT NOT NULL,
            target_branch TEXT NOT NULL,
            base_revision TEXT,
            reviewed_revision TEXT NOT NULL,
            audit_id TEXT REFERENCES security_audits(id),
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved_push','approved_keep_local','approved_pr','rejected','invalidated','cancelled')),
            diff_summary_json TEXT NOT NULL DEFAULT '{}',
            files_changed_json TEXT NOT NULL DEFAULT '[]',
            proposed_commit_message TEXT,
            discord_message_id TEXT,
            discord_channel_id TEXT,
            pr_url TEXT,
            pr_number INTEGER,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            invalidated_at TEXT,
            invalidation_reason TEXT
          );
          INSERT INTO git_approval_requests_new (
            id, task_id, job_id, project_id, repository_identity, target_branch, base_revision, reviewed_revision,
            audit_id, status, diff_summary_json, files_changed_json, proposed_commit_message, discord_message_id, discord_channel_id, created_at, invalidated_at, invalidation_reason
          )
          SELECT
            id, task_id, job_id, project_id, repository_identity, target_branch, base_revision, reviewed_revision,
            audit_id, status, diff_summary_json, files_changed_json, proposed_commit_message, discord_message_id, discord_channel_id, created_at, invalidated_at, invalidation_reason
          FROM git_approval_requests;
          DROP TABLE git_approval_requests;
          ALTER TABLE git_approval_requests_new RENAME TO git_approval_requests;
          CREATE INDEX IF NOT EXISTS idx_git_approval_requests_task ON git_approval_requests(task_id);
          CREATE INDEX IF NOT EXISTS idx_git_approval_requests_job ON git_approval_requests(job_id);
          CREATE INDEX IF NOT EXISTS idx_git_approval_requests_status ON git_approval_requests(status);

          CREATE TABLE git_approval_decisions_new (
            id TEXT PRIMARY KEY,
            approval_request_id TEXT NOT NULL REFERENCES git_approval_requests(id) ON DELETE CASCADE,
            discord_user_id TEXT NOT NULL,
            decision TEXT NOT NULL CHECK(decision IN ('push','keep_local','reject','create_pr')),
            decision_timestamp TEXT NOT NULL DEFAULT (datetime('now')),
            metadata_json TEXT NOT NULL DEFAULT '{}'
          );
          INSERT INTO git_approval_decisions_new SELECT * FROM git_approval_decisions;
          DROP TABLE git_approval_decisions;
          ALTER TABLE git_approval_decisions_new RENAME TO git_approval_decisions;
          CREATE INDEX IF NOT EXISTS idx_git_approval_decisions_req ON git_approval_decisions(approval_request_id);

          CREATE TABLE git_operations_new (
            id TEXT PRIMARY KEY,
            task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
            job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            approval_request_id TEXT REFERENCES git_approval_requests(id),
            operation TEXT NOT NULL CHECK(operation IN ('commit_and_push','keep_local','revalidate','create_pr')),
            remote TEXT NOT NULL,
            branch TEXT NOT NULL,
            commit_sha TEXT,
            pr_url TEXT,
            pr_number INTEGER,
            status TEXT NOT NULL CHECK(status IN ('pending','running','success','failed')),
            error_code TEXT,
            error_message TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            completed_at TEXT
          );
          INSERT INTO git_operations_new (
            id, task_id, job_id, project_id, approval_request_id, operation, remote, branch, commit_sha, status, error_code, error_message, created_at, completed_at
          )
          SELECT id, task_id, job_id, project_id, approval_request_id, operation, remote, branch, commit_sha, status, error_code, error_message, created_at, completed_at FROM git_operations;
          DROP TABLE git_operations;
          ALTER TABLE git_operations_new RENAME TO git_operations;
          CREATE INDEX IF NOT EXISTS idx_git_operations_task ON git_operations(task_id);
          CREATE INDEX IF NOT EXISTS idx_git_operations_job ON git_operations(job_id);
          CREATE INDEX IF NOT EXISTS idx_git_operations_status ON git_operations(status);
        `);
      })();
      db.pragma('foreign_keys = ON');
    }
  } catch (err) {
    db.pragma('foreign_keys = ON');
  }

  initMigrations();
  const txMigrations = db.transaction(() => {
    for (const sql of allMigrations) db.exec(sql);
  });
  txMigrations();
  ensureIndexes();
};

export const checkpoint = () => {
  try {
    db.pragma('wal_checkpoint(PASSIVE)');
  } catch {}
};

export const close = () => {
  try {
    checkpoint();
    db.close();
  } catch {}
};

export const dbGet = (sql, params) => db.prepare(sql).all(...(params || []));
export const dbRun = (sql, params) => db.prepare(sql).run(...(params || []));
export const dbGetOne = (sql, params) => db.prepare(sql).get(...(params || []));
export const dbPrepare = (sql) => db.prepare(sql);
export default db;
