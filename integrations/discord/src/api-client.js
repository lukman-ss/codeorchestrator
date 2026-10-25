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

  async fetchProjects() {
    return this.request('/projects');
  }

  async getProject(id) {
    return this.request(`/projects/${id}`);
  }

  async resolveProject(idOrSlug) {
    if (!idOrSlug) return null;
    const projects = await this.fetchProjects();
    const match = projects.find(p => p.id === idOrSlug || p.slug === idOrSlug || p.name.toLowerCase() === idOrSlug.toLowerCase());
    return match || null;
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
