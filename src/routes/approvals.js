import { z } from 'zod';
import { ApprovalService } from '../services/approval-service.js';
import { WorkflowService } from '../services/workflow-service.js';
import { dbGetOne, dbGet } from '../database/db.js';

const decideSchema = z.object({
  decision: z.enum(['push', 'keep_local', 'reject']),
  userId: z.string().min(1)
});

export default async function approvals(app) {
  // List pending approval requests
  app.get('/approvals/pending', async (req, reply) => {
    try {
      const items = ApprovalService.listPendingApprovals(req.query?.projectId || null);
      reply.send(items);
    } catch (err) {
      reply.code(500).send({ error: err.message });
    }
  });

  // Get specific approval request
  app.get('/approvals/:id', async (req, reply) => {
    try {
      const item = ApprovalService.getApprovalRequest(req.params.id);
      if (!item) {
        reply.code(404).send({ error: 'Approval request not found' });
        return;
      }
      reply.send(item);
    } catch (err) {
      reply.code(500).send({ error: err.message });
    }
  });

  // Process approval decision (push or keep_local)
  app.post('/approvals/:id/decide', async (req, reply) => {
    try {
      const { decision, userId } = decideSchema.parse(req.body);
      const res = await ApprovalService.processDecision({
        approvalRequestId: req.params.id,
        userId,
        decision
      });
      reply.send(res);
    } catch (err) {
      const code = err.statusCode || (err.message.includes('not found') ? 404 : 400);
      reply.code(code).send({ error: err.message });
    }
  });

  // Get workflow review for task
  app.get('/tasks/:id/review', async (req, reply) => {
    try {
      const review = WorkflowService.getWorkflowReview(req.params.id);
      const approval = ApprovalService.getApprovalRequestByTaskOrJob(req.params.id);
      if (!review && !approval) {
        reply.code(404).send({ error: 'Review not found for task' });
        return;
      }
      reply.send({ review, approval });
    } catch (err) {
      reply.code(500).send({ error: err.message });
    }
  });

  // Get workflow review for job
  app.get('/jobs/:id/review', async (req, reply) => {
    try {
      const review = WorkflowService.getWorkflowReview(req.params.id);
      const approval = ApprovalService.getApprovalRequestByTaskOrJob(req.params.id);
      if (!review && !approval) {
        reply.code(404).send({ error: 'Review not found for job' });
        return;
      }
      reply.send({ review, approval });
    } catch (err) {
      reply.code(500).send({ error: err.message });
    }
  });

  // Get security audit for task
  app.get('/tasks/:id/security-audit', async (req, reply) => {
    try {
      const audit = dbGetOne('SELECT * FROM security_audits WHERE task_id = ? ORDER BY created_at DESC LIMIT 1', [req.params.id]);
      if (!audit) {
        reply.code(404).send({ error: 'Security audit not found for task' });
        return;
      }
      const findings = dbGet('SELECT * FROM security_findings WHERE audit_id = ?', [audit.id]);
      try { audit.severity_summary = JSON.parse(audit.severity_summary_json || '{}'); } catch {}
      try { audit.scanners_executed = JSON.parse(audit.scanners_executed_json || '[]'); } catch {}
      try { audit.limitations = JSON.parse(audit.limitations_json || '[]'); } catch {}
      reply.send({ audit, findings });
    } catch (err) {
      reply.code(500).send({ error: err.message });
    }
  });

  // Get security audit for job
  app.get('/jobs/:id/security-audit', async (req, reply) => {
    try {
      const audit = dbGetOne('SELECT * FROM security_audits WHERE job_id = ? ORDER BY created_at DESC LIMIT 1', [req.params.id]);
      if (!audit) {
        reply.code(404).send({ error: 'Security audit not found for job' });
        return;
      }
      const findings = dbGet('SELECT * FROM security_findings WHERE audit_id = ?', [audit.id]);
      try { audit.severity_summary = JSON.parse(audit.severity_summary_json || '{}'); } catch {}
      try { audit.scanners_executed = JSON.parse(audit.scanners_executed_json || '[]'); } catch {}
      try { audit.limitations = JSON.parse(audit.limitations_json || '[]'); } catch {}
      reply.send({ audit, findings });
    } catch (err) {
      reply.code(500).send({ error: err.message });
    }
  });
}
