#!/usr/bin/env node
// SessionStart hook for the Glance plugin. Two jobs, both quiet:
//  1. hand the session the Glance rules as extra context, so no CLAUDE.md edit is needed;
//  2. make sure the Glance server is running, without opening a browser.
// Sessions the Glance page starts itself already carry the rules in their prompt, so they are skipped.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

if (process.env.GLANCE_DRIVEN) process.exit(0);

const root = __dirname;
const data = process.env.GLANCE_DATA || path.join(os.homedir(), '.claude', 'glance');
const port = Number(process.env.BOARD_PORT) || 4777;
let rules = '';
try { rules = fs.readFileSync(path.join(root, 'BOARD.md'), 'utf8').trim(); } catch {}
if (rules) {
  rules += `\n\nOn this machine the board file is ${path.join(data, 'board.html')} and the block syntax is in ${path.join(root, 'VIZ.md')}. The Glance page is at http://127.0.0.1:${port}.`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: rules } }));
}

try {
  spawn(process.execPath, [path.join(root, 'server.js'), '--quiet'], { detached: true, stdio: 'ignore' }).unref();
} catch {}
