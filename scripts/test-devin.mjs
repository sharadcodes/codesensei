// Quick test: spawn Devin ACP, initialize, session/new, send a prompt, capture response
import { spawn } from 'child_process';

const CWD = 'D:\\DEV\\TEST\\dummy-project';
const CMD = 'devin';
const ARGS = ['acp'];

const proc = spawn(CMD, ARGS, {
  cwd: CWD,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  shell: false,
});

let buf = '';
let nextId = 1;
const pending = new Map();

proc.stdout.setEncoding('utf8');
proc.stdout.on('data', (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    
    // Response to our request
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error.message || 'ACP error'));
        else waiter.resolve(msg.result);
      }
    }
    
    // Server notification
    if (msg.method) {
      console.log(`[NOTIFY] ${msg.method}: ${JSON.stringify(msg.params || {}).slice(0, 200)}`);
      // Auto-respond to permission requests
      if (msg.method === 'session/request_permission' || msg.method === 'session/requestPermission') {
        const response = { jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'accepted' } } };
        proc.stdin.write(JSON.stringify(response) + '\n');
      }
      // Session updates
      if (msg.method === 'session/update') {
        const update = msg.params?.update;
        if (update?.sessionUpdate === 'agent_message_chunk') {
          process.stdout.write(update.content?.text || '');
        }
      }
    }
  }
});

proc.stderr.on('data', (d) => {
  const s = d.toString();
  if (s.trim()) console.error(`[stderr] ${s.trim()}`);
});

proc.on('exit', (code) => {
  console.log(`\n[exit] code=${code}`);
});

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const req = { jsonrpc: '2.0', id, method, params };
    console.log(`\n→ ${method} (id=${id})`);
    proc.stdin.write(JSON.stringify(req) + '\n');
  });
}

async function run() {
  try {
    // 1. Initialize
    const initResult = await send('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'test-script', title: 'Test Script', version: '0.1.0' },
    });
    console.log('✓ Initialize:', JSON.stringify(initResult).slice(0, 300));

    // 2. session/new
    const sessionResult = await send('session/new', {
      cwd: CWD,
      mcpServers: [],
    });
    const sessionId = sessionResult?.sessionId;
    console.log('✓ session/new:', JSON.stringify(sessionResult).slice(0, 300));
    if (!sessionId) throw new Error('No sessionId in session/new response');

    // 3. Send a prompt
    const promptResult = await send('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'What does the calculate_total function do? Answer in one sentence.' }],
    });
    console.log('✓ session/prompt:', JSON.stringify(promptResult).slice(0, 300));

    // Wait a bit for updates
    await new Promise((r) => setTimeout(r, 5000));

    // 4. Close session
    await send('session/close', { sessionId }).catch(() => {});
    console.log('✓ session/close');

  } catch (e) {
    console.error('✗ Error:', e.message);
  } finally {
    proc.kill();
    process.exit(0);
  }
}

run();
