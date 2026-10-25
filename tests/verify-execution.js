import http from 'node:http';
import WebSocket from 'ws';

const BASE = 'http://127.0.0.1:4000';
const TOKEN = 'test-token-123';

function req(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
    const opts = { method, headers };
    const r = http.request(new URL(path, BASE), opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function main() {
  // Health check
  const h = await req('/health');
  console.log('1. Health:', h.status, JSON.stringify(h.body));
  
  // Get projects (use existing)
  const projects = await req('/projects');
  console.log('2. Projects status:', projects.status, 'count:', projects.body.length);
  const proj = projects.body[projects.body.length - 1];
  console.log('   Using project:', proj.slug, proj.id);
  
  // Submit simple task
  const taskRes = await req(`/projects/${proj.id}/tasks`, 'POST', {
    prompt: 'Write a file named marker.txt containing hello-from-opencode',
    model: '9router/ayce-combo'
  });
  console.log('3. Task submit:', taskRes.status, JSON.stringify(taskRes.body));
  const taskId = taskRes.body.id;
  
  // Subscribe via WebSocket
  const ws = new WebSocket('ws://127.0.0.1:4000/ws', [TOKEN]);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  console.log('4. WebSocket connected');
  
  const events = [];
  ws.on('message', (msg) => {
    const ev = JSON.parse(msg.toString());
    events.push(ev);
    console.log('   WS event:', ev.type, ev.data ? JSON.stringify(ev.data).slice(0, 100) : '');
  });
  
  ws.send(JSON.stringify({ type: 'subscribe', taskId }));
  
  // Wait for task to complete
  console.log('5. Waiting for task...');
  let status = 'queued';
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const t = await req(`/tasks/${taskId}`);
    status = t.body.status;
    if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted') {
      console.log('   Task status:', status);
      break;
    }
    if (i % 5 === 0) console.log('   Still waiting...', status);
  }
  
  ws.close();
  
  // Check session
  const task = await req(`/tasks/${taskId}`);
  console.log('6. Final task status:', task.body.status, 'session_id:', task.body.session_id);
  
  if (task.body.session_id) {
    const sess = await req(`/sessions/${task.body.session_id}`);
    console.log('7. Session:', sess.status, sess.body.opencode_session_id ? 'HAS opencode_session_id: ' + sess.body.opencode_session_id : 'NO opencode_session_id');
  } else {
    console.log('7. No session_id on task');
  }
  
  // Check workspace files
  const proj2 = await req(`/projects/${proj.id}`);
  console.log('8. Project workspace_path:', proj2.body.workspace_path);
  
  // Get file list via events
  const eventLog = await req(`/tasks/${taskId}/events`);
  console.log('9. Events count:', eventLog.body.length);
  const toolEvents = eventLog.body.filter(e => e.type === 'task.tool');
  console.log('   Tool events:', toolEvents.length);
  console.log('   Events types:', [...new Set(eventLog.body.map(e => e.type))]);
}

main().catch(console.error);
