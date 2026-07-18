// Probe an ACP agent's initialize response to see real capabilities.
import { spawn } from 'child_process';

const cmd = process.argv[2];
const args = process.argv.slice(3);
const isCmdShim = process.platform === 'win32' && /\.cmd$/i.test(cmd);
const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: isCmdShim });
let buf = '';
let done = false;

const initReq = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  },
};

proc.stdout.setEncoding('utf8');
proc.stdout.on('data', (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id === 1) {
        console.log(JSON.stringify(msg.result, null, 2));
        done = true;
        proc.stdin.end();
        setTimeout(() => process.exit(0), 200);
      }
    } catch (e) {
      console.error('parse error:', e.message, 'line:', line.slice(0, 200));
    }
  }
});
proc.stderr.on('data', (d) => {
  const s = d.toString();
  if (/error|warn/i.test(s)) console.error('STDERR:', s.trim());
});
proc.on('exit', (code) => {
  if (!done) console.error('agent exited before initialize response, code=', code);
  process.exit(done ? 0 : 1);
});

setTimeout(() => {
  if (!done) {
    console.error('TIMEOUT: no initialize response in 15s');
    process.exit(2);
  }
}, 15000);

proc.stdin.write(JSON.stringify(initReq) + '\n');
