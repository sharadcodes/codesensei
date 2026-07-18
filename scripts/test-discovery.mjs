// Standalone test of ACP agent discovery — no vscode dependency.
import { spawn } from 'child_process';
import * as path from 'path';

const IS_WINDOWS = process.platform === 'win32';

const BUILTIN_AGENTS = [
  {
    id: 'codex',
    name: 'Codex',
    launch: { cmd: IS_WINDOWS ? 'npx.cmd' : 'npx', args: ['-y', '@agentclientprotocol/codex-acp'] },
    pathProbe: IS_WINDOWS ? 'npx.cmd' : 'npx',
  },
  {
    id: 'devin',
    name: 'Devin',
    launch: { cmd: IS_WINDOWS ? 'devin.exe' : 'devin', args: ['acp'] },
    pathProbe: IS_WINDOWS ? 'devin.exe' : 'devin',
  },
];

async function isOnPath(cmd) {
  if (path.isAbsolute(cmd)) {
    try { await import('fs/promises').then((fs) => fs.access(cmd)); return true; } catch { return false; }
  }
  const tool = IS_WINDOWS ? 'where.exe' : 'which';
  return new Promise((resolve) => {
    const p = spawn(tool, [cmd], { windowsHide: true });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

function probeInitialize(resolved) {
  return new Promise((resolve, reject) => {
    const shell = resolved.shell ?? false;
    const proc = spawn(resolved.cmd, resolved.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell });
    let buf = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return; settled = true;
      try { proc.kill(); } catch {}
      reject(new Error('initialize timed out after 20s'));
    }, 20000);
    const initReq = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } };
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
        if (msg.id === 1 && (msg.result || msg.error)) {
          if (settled) return; settled = true;
          clearTimeout(timeout);
          try { proc.stdin.end(); } catch {}
          try { proc.kill(); } catch {}
          if (msg.error) reject(new Error(msg.error.message || 'initialize error'));
          else resolve(msg.result);
        }
      }
    });
    proc.on('error', (err) => { if (settled) return; settled = true; clearTimeout(timeout); reject(err); });
    proc.on('exit', (code) => { if (settled) return; settled = true; clearTimeout(timeout); reject(new Error(`agent exited code=${code} before initialize response`)); });
    try { proc.stdin.write(JSON.stringify(initReq) + '\n'); } catch (e) { if (settled) return; settled = true; clearTimeout(timeout); reject(e); }
  });
}

(async () => {
  console.log('Discovering ACP agents (codex + devin)...\n');
  for (const spec of BUILTIN_AGENTS) {
    console.log(`=== ${spec.name} (${spec.id}) ===`);
    const onPath = await isOnPath(spec.pathProbe);
    console.log(`  on PATH: ${onPath}`);
    if (!onPath) { console.log(); continue; }
    const shell = IS_WINDOWS && /\.cmd$/i.test(spec.launch.cmd);
    const resolved = { cmd: spec.launch.cmd, args: spec.launch.args, shell };
    try {
      const caps = await probeInitialize(resolved);
      console.log(`  probed: OK`);
      console.log(`  agentInfo: ${caps.agentInfo?.title ?? caps.agentInfo?.name} v${caps.agentInfo?.version}`);
      const c = caps.agentCapabilities;
      if (c) {
        console.log(`  promptCapabilities: ${JSON.stringify(c.promptCapabilities)}`);
        console.log(`  mcpCapabilities: ${JSON.stringify(c.mcpCapabilities)}`);
        console.log(`  sessionCapabilities: ${JSON.stringify(c.sessionCapabilities)}`);
        console.log(`  loadSession: ${c.loadSession}`);
      }
      console.log(`  authMethods: ${caps.authMethods?.map((m) => `${m.name}(${m.id})`).join(', ')}`);
    } catch (e) {
      console.log(`  probed: FAILED — ${e.message}`);
    }
    console.log();
  }
  process.exit(0);
})();
