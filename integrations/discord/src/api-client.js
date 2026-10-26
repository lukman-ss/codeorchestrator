import config from './config.js';

export class OrchestratorApiClient {
  constructor(cfg = config) {
    this.baseUrl = cfg.apiUrl;
    this.apiToken = cfg.apiToken;
    this.timeoutMs = cfg.apiTimeoutMs || 10000;
  }

  async request(path, options = {}) {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...options.headers
    };

    if (this.apiToken) {
      headers['Authorization'] = `Bearer ${this.apiToken}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      });

      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }

      if (!response.ok) {
        const errorMsg = data?.error || data?.message || `HTTP ${response.status} ${response.statusText}`;
        const err = new Error(errorMsg);
        err.status = response.status;
        err.data = data;
        throw err;
      }

      return data;
    } catch (err) {
      if (err.name === 'AbortError') {
        const timeoutErr = new Error(`Request timed out after ${this.timeoutMs}ms: ${url}`);
        timeoutErr.status = 504;
        throw timeoutErr;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async getHealth() {
    return this.request('/health');
  }

  async fetchProjects(params = {}) {
    const qs = new URLSearchParams();
    if (params.includeTest) qs.set('includeTest', 'true');
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return this.request(`/projects${query}`);
  }

  async getProject(id) {
    return this.request(`/projects/${id}`);
  }

  async createProject(data) {
    return this.request('/projects', {
      method: 'POST',
      body: data
    });
  }

  async createProjectAsync(data) {
    return this.request('/projects', {
      method: 'POST',
      body: { ...data, async: true }
    });
  }

  async getProjectOperation(id) {
    return this.request(`/projects/operations/${id}`);
  }

  async importProject({ directory, name, isTest } = {}) {
    return this.request('/projects/import', {
      method: 'POST',
      body: { directory, name, isTest }
    });
  }

  async getProjectTasks(projectId) {
    return this.request(`/projects/${projectId}/tasks`);
  }

  async resolveProject(idOrSlug) {
    if (!idOrSlug) return null;
    const projects = await this.fetchProjects();
    const match = projects.find(p => p.id === idOrSlug || p.slug === idOrSlug || p.name.toLowerCase() === idOrSlug.toLowerCase());
    return match || null;
  }

  async fetchSessions(params = {}) {
    const qs = new URLSearchParams();
    if (params.type) qs.set('type', params.type);
    if (params.projectId) qs.set('projectId', params.projectId);
    if (params.userId) qs.set('userId', params.userId);
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.offset) qs.set('offset', String(params.offset));
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return this.request(`/sessions${query}`);
  }

  async fetchProjectSessions(projectId) {
    return this.request(`/projects/${projectId}/sessions`);
  }

  async getSession(id) {
    return this.request(`/sessions/${id}`);
  }

  async createSession({ title, type = 'standalone', projectId = null, model, userId, metadata } = {}) {
    return this.request('/sessions', {
      method: 'POST',
      body: { title, type, projectId, model, userId, metadata }
    });
  }

  async createProjectSession(projectId, { title, model, userId, metadata } = {}) {
    return this.request(`/projects/${projectId}/sessions`, {
      method: 'POST',
      body: { title, model, userId, metadata }
    });
  }

  async sendSessionMessage(sessionId, { prompt, model, userId } = {}) {
    return this.request(`/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: { prompt, model, userId }
    });
  }

  async getSessionMessages(sessionId) {
    return this.request(`/sessions/${sessionId}/messages`);
  }

  async resolveSession(idOrTitle) {
    if (!idOrTitle) return null;
    try {
      return await this.getSession(idOrTitle);
    } catch {
      const all = await this.fetchSessions({ limit: 100 });
      return all.find(s => s.id === idOrTitle || (s.title && s.title.toLowerCase() === idOrTitle.toLowerCase())) || null;
    }
  }

  async createTask(projectId, { prompt, model, sessionId } = {}) {
    return this.request(`/projects/${projectId}/tasks`, {
      method: 'POST',
      body: { prompt, model, sessionId }
    });
  }

  async getTask(taskId) {
    return this.request(`/tasks/${taskId}`);
  }

  async getTaskEvents(taskId, afterSequence = 0) {
    return this.request(`/tasks/${taskId}/events?afterSequence=${afterSequence}`);
  }

  async cancelTask(taskId) {
    return this.request(`/tasks/${taskId}/cancel`, {
      method: 'POST',
      body: {}
    });
  }

  async createJob(projectId, prompt) {
    return this.request('/jobs', {
      method: 'POST',
      body: { project_id: projectId, prompt }
    });
  }

  async getJob(jobId) {
    return this.request(`/jobs/${jobId}`);
  }

  async getJobSubtasks(jobId) {
    return this.request(`/jobs/${jobId}/subtasks`);
  }

  async getJobReport(jobId) {
    return this.request(`/jobs/${jobId}/report`);
  }

  async getJobAgents(jobId) {
    return this.request(`/jobs/${jobId}/agents`);
  }

  async getSubtaskAudits(subtaskId) {
    return this.request(`/subtasks/${subtaskId}/audit`);
  }

  async cancelJob(jobId) {
    return this.request(`/jobs/${jobId}/cancel`, {
      method: 'POST',
      body: {}
    });
  }
}

export default new OrchestratorApiClient();
