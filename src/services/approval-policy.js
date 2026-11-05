export function hasSensitiveOrBreaking(app) {
  if (!app) return false;
  let files = app.files_changed || app.files_changed_json;
  if (typeof files === 'string') {
    try { files = JSON.parse(files); } catch { files = []; }
  }
  files = files || [];
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
    if (typeof f === 'string' && sensitive.some(pat => pat.test(f))) return true;
  }
  const msg = (app.proposed_commit_message || '').toLowerCase();
  if (msg.includes('breaking') || msg.includes('drop table') || msg.includes('drop database') || msg.includes('schema migration') || msg.includes('truncate')) {
    return true;
  }
  return false;
}

export function getImpactLevel(app) {
  if (!app) return 'high';
  if (hasSensitiveOrBreaking(app)) return 'high';

  let diff = app.diff_summary || app.diff_summary_json;
  if (typeof diff === 'string') {
    try { diff = JSON.parse(diff); } catch { diff = {}; }
  }
  diff = diff || {};

  let files = app.files_changed || app.files_changed_json;
  if (typeof files === 'string') {
    try { files = JSON.parse(files); } catch { files = []; }
  }
  files = files || [];

  const delCount = diff.deleted || 0;
  if (files.length > 15 || delCount > 3) return 'high';
  if (files.length <= 5 && delCount === 0) return 'low';
  return 'medium';
}

export function isEligibleForAutoApprove(app, level = 'OFF') {
  const lvl = (level || 'OFF').toUpperCase().trim();
  if (lvl === 'OFF') return false;
  if (lvl === 'MAX' || lvl === 'NO LIMIT') return true;

  const impact = getImpactLevel(app);
  if (lvl === 'LOW') return impact === 'low';
  if (lvl === 'MEDIUM') return impact === 'low' || impact === 'medium';
  if (lvl === 'HIGH') return !hasSensitiveOrBreaking(app);
  return false;
}
