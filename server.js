#!/usr/bin/env node
// Glance: serves ~/.claude/glance/board.html with a chat dock, and relays chat
// messages to the real `claude` CLI so answers run on the normal Claude Code login.
//
//   node server.js          start the server in the background if needed (opens the browser when it starts it)
//   node server.js --open   same, but always open the browser
//   node server.js --serve  run the server in the foreground
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const PORT = Number(process.env.BOARD_PORT) || 4777;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
// Everything Glance writes lives here, apart from the code: the board file, history, log and page token.
// The plugin's own folder is replaced on every update, so nothing is kept there.
const DATA = process.env.GLANCE_DATA || path.join(CLAUDE_DIR, 'glance');
const BOARD = path.join(DATA, 'board.html');
const UI = path.join(__dirname, 'ui.html');
const RULES = path.join(__dirname, 'BOARD.md'); // the rules every session gets, so CLAUDE.md needs nothing
const VIZ = path.join(__dirname, 'VIZ.md');
const LOG = path.join(DATA, 'server.log');
const QUIET = process.argv.includes('--quiet'); // from the session-start hook: never open a browser, print nothing
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECTS = path.join(CLAUDE_DIR, 'projects');
const MODES = new Set(['auto', 'acceptEdits', 'plan', 'bypassPermissions']);
// Files the pages may load from ~/.claude/board, served under /board/.
const STATIC = { 'board.css': 'text/css; charset=utf-8', 'viz.js': 'text/javascript; charset=utf-8', 'mermaid.min.js': 'text/javascript; charset=utf-8', 'fonts/inter.woff2': 'font/woff2', 'fonts/jetbrains-mono.woff2': 'font/woff2', 'marked.min.js': 'text/javascript; charset=utf-8', 'highlight.min.js': 'text/javascript; charset=utf-8' };

fs.mkdirSync(DATA, { recursive: true });
migrate();
if (process.argv.includes('--serve')) serve();
else launch(process.argv.includes('--open'));

// Earlier versions kept the board at ~/.claude/board.html and history next to the code. Move them once,
// and leave a symlink at the old board path so sessions still running with the old rules keep landing here.
function migrate() {
  const oldBoard = path.join(CLAUDE_DIR, 'board.html');
  try {
    if (!fs.existsSync(BOARD) && fs.existsSync(oldBoard) && !fs.lstatSync(oldBoard).isSymbolicLink()) {
      fs.renameSync(oldBoard, BOARD);
      fs.symlinkSync(BOARD, oldBoard);
    }
  } catch (e) { console.error('migrate board:', e.message); }
  const oldHistory = path.join(__dirname, 'history');
  try {
    if (!fs.existsSync(path.join(DATA, 'history')) && fs.existsSync(oldHistory)) fs.renameSync(oldHistory, path.join(DATA, 'history'));
  } catch (e) { console.error('migrate history:', e.message); }
}

function openUrl(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args, () => {});
}

// ---------- launcher ----------

function healthy() {
  return new Promise(resolve => {
    const req = http.get(`${URL_BASE}/health`, { timeout: 500 }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function launch(forceOpen) {
  let started = false;
  if (!(await healthy())) {
    const log = fs.openSync(LOG, 'a');
    spawn(process.execPath, [__filename, '--serve'], { detached: true, stdio: ['ignore', log, log] }).unref();
    for (let i = 0; i < 30 && !(await healthy()); i++) await new Promise(r => setTimeout(r, 100));
    if (!(await healthy())) { if (!QUIET) console.error(`Glance server didn't start, see ${LOG}`); process.exit(1); }
    started = true;
  }
  if (QUIET) return;
  if (started || forceOpen) openUrl(URL_BASE);
  console.log(`Glance at ${URL_BASE}${started ? ' (started)' : ''}`);
}

// ---------- server ----------

function serve() {
  // The page's key to this server. Kept on disk so a restart doesn't strand open tabs.
  const TOKEN_FILE = path.join(DATA, '.token');
  let token = '';
  try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
  if (!/^[0-9a-f]{48}$/.test(token)) {
    token = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  }
  const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
  const clients = new Set();
  const running = new Map(); // requested session id -> child process
  const aliases = new Map(); // requested session id -> id the CLI actually used (when it had to copy a live session)
  const live = new Map();    // session id -> { child, mode, busy, timer }: a long-running process kept warm for voice
  const spoken = new Map();  // board section id -> narration last read aloud
  const speech = [];         // lines waiting to be read aloud
  let speaker = null;        // the running `say` process
  let muted = false;         // when on, nothing is read aloud; replies stay text
  const nudges = new Map();  // conversation id -> short line to say once the current speech ends
  const CHIME = '/System/Library/Sounds/Pop.aiff';
  const VOICE_IDLE_MS = 10 * 60 * 1000;

  const broadcast = evt => {
    const data = `data: ${JSON.stringify(evt)}\n\n`;
    for (const res of clients) res.write(data);
  };

  // ---------- every version of every section, kept per conversation ----------
  // Sessions replace their section in board.html; each new version is appended to
  // history/<session id>.jsonl so the page can show a conversation's visuals over time.
  const HISTORY = path.join(DATA, 'history');
  fs.mkdirSync(HISTORY, { recursive: true });
  const latest = new Map(); // session id -> { hash, ts, updated, cwd, title, say, count }

  const attr = (html, name) => (html.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1] || '';
  const untag = t => t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const decode = t => t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  function metaOf(html) {
    const open = html.match(/^<section\b[^>]*>/)?.[0] || '';
    return {
      id: attr(open, 'data-session'),
      cwd: attr(open, 'data-cwd'),
      updated: attr(open, 'data-updated'),
      title: decode(untag(((html.match(/<header>\s*<span>([\s\S]*?)<\/span>/) || html.match(/<header>([\s\S]*?)<\/header>/) || [])[1] || '').replace(/<b>[\s\S]*?<\/b>/, ''))).replace(/^[\s—–·-]+/, ''),
      say: decode(untag((html.match(/<p data-say hidden>([\s\S]*?)<\/p>/) || [])[1] || '')),
      update: decode(untag((html.match(/<p data-say-update hidden>([\s\S]*?)<\/p>/) || [])[1] || '')),
    };
  }
  const historyFile = id => path.join(HISTORY, `${id.toLowerCase()}.jsonl`);
  // Two versions of a section are "the same visual" when most of their lines match.
  const bodyLines = html => html.replace(/<p data-say(?:-update)? hidden>[\s\S]*?<\/p>/g, '').replace(/<header>[\s\S]*?<\/header>/, '').replace(/^<section\b[^>]*>/, '').split('\n').map(l => l.trim()).filter(Boolean);
  function similar(a, b) {
    const la = bodyLines(a), lb = bodyLines(b);
    if (!la.length || !lb.length) return false;
    const pool = new Map();
    for (const l of la) pool.set(l, (pool.get(l) || 0) + 1);
    let common = 0;
    for (const l of lb) if (pool.get(l)) { common++; pool.set(l, pool.get(l) - 1); }
    return common / Math.max(la.length, lb.length) >= 0.6;
  }
  function readHistory(id) {
    try { return fs.readFileSync(historyFile(id), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
  }
  for (const f of fs.readdirSync(HISTORY)) {
    if (!f.endsWith('.jsonl')) continue;
    const entries = readHistory(f.slice(0, -6));
    const last = entries[entries.length - 1];
    if (last) latest.set(f.slice(0, -6), { ...metaOf(last.html), hash: last.hash, ts: last.ts, count: entries.length, html: last.html });
  }
  function archive() {
    let html = '';
    try { html = fs.readFileSync(BOARD, 'utf8'); } catch { return []; }
    const changed = [];
    for (const m of html.matchAll(/<section\b[^>]*\bdata-session="([^"]+)"[^>]*>[\s\S]*?<\/section>/g)) {
      const id = m[1].toLowerCase();
      if (!UUID.test(id)) continue;
      const hash = crypto.createHash('sha1').update(m[0]).digest('hex');
      const had = latest.get(id);
      if (had?.hash === hash) continue;
      const ts = new Date().toISOString();
      const meta = { ...metaOf(m[0]), id, hash, ts, count: (had?.count || 0) + 1 };
      // A small change to the previous visual revises it in place instead of stacking a new one.
      const rev = !!had && (!!meta.update || similar(had.html || '', m[0]));
      fs.appendFileSync(historyFile(id), JSON.stringify({ ts, hash, rev, html: m[0] }) + '\n');
      latest.set(id, { ...meta, html: m[0] });
      changed.push({ id, updated: meta.updated, revision: rev, say: rev ? (meta.update || 'I updated the visual.') : meta.say });
    }
    return changed;
  }
  archive();
  fs.watchFile(BOARD, { interval: 400 }, () => broadcast({ kind: 'board', changed: archive() }));
  // The app reloads itself when its own code or styles change.
  for (const f of ['ui.html', 'board.css', 'viz.js']) fs.watchFile(path.join(__dirname, f), { interval: 1000 }, () => broadcast({ kind: 'reload' }));

  const childEnv = { ...process.env, GLANCE_DRIVEN: '1' }; // tells the plugin's session-start hook the rules are already in the prompt
  delete childEnv.CLAUDECODE;
  delete childEnv.CLAUDE_CODE_ENTRYPOINT;
  childEnv.CLAUDE_BOARD = '1'; // lets hooks know the board handles speech for these sessions

  // ---------- recent conversations from ~/.claude/projects ----------

  const sessionCache = new Map(); // file -> { mtimeMs, info }

  function sessionInfo(file, mtimeMs) {
    const hit = sessionCache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.info;
    let cwd = '', custom = '', ai = '', prompt = '';
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      if (!cwd && line.includes('"cwd"')) { try { cwd = JSON.parse(line).cwd || ''; } catch {} }
      if (line.startsWith('{"type":"custom-title"')) { try { custom = JSON.parse(line).customTitle || custom; } catch {} }
      else if (line.startsWith('{"type":"ai-title"')) { try { ai = JSON.parse(line).aiTitle || ai; } catch {} }
      else if (line.startsWith('{"type":"last-prompt"')) { try { prompt = JSON.parse(line).lastPrompt || prompt; } catch {} }
    }
    const info = { cwd, title: String(custom || ai || prompt).replace(/\s+/g, ' ').slice(0, 70) };
    sessionCache.set(file, { mtimeMs, info });
    return info;
  }

  function recentSessions(limit = 30, days = 14) {
    const cutoff = Date.now() - days * 864e5;
    const files = [];
    for (const dir of fs.readdirSync(PROJECTS, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const full = path.join(PROJECTS, dir.name);
      for (const f of fs.readdirSync(full)) {
        if (!f.endsWith('.jsonl') || !UUID.test(f.slice(0, -6))) continue;
        try {
          const st = fs.statSync(path.join(full, f));
          if (st.mtimeMs >= cutoff) files.push({ file: path.join(full, f), id: f.slice(0, -6), mtimeMs: st.mtimeMs });
        } catch {}
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const out = [];
    for (const f of files) {
      if (out.length >= limit) break;
      let info;
      try { info = sessionInfo(f.file, f.mtimeMs); } catch { continue; }
      if (!info.cwd || /^\/(private\/)?tmp\//.test(info.cwd)) continue; // skip scratch and test sessions
      out.push({ id: f.id, cwd: info.cwd, title: info.title, updated: new Date(f.mtimeMs).toISOString(), waiting: !running.has(f.id) && !live.get(f.id)?.busy && waitingOn(f.file) });
    }
    return out;
  }

  // ---------- full conversation for the side panel ----------

  const fileCache = new Map(); // session id -> transcript path

  function sessionFile(id) {
    const hit = fileCache.get(id);
    if (hit && fs.existsSync(hit)) return hit;
    if (!fs.existsSync(PROJECTS)) return null;
    for (const dir of fs.readdirSync(PROJECTS, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const f = path.join(PROJECTS, dir.name, `${id}.jsonl`);
      if (fs.existsSync(f)) { fileCache.set(id, f); return f; }
    }
    return null;
  }

  // Your messages and Claude's full replies (all text in a turn joined), without tool calls or system notes.
  // A conversation is "waiting on you" when its last message is Claude asking a question.
  const waitCache = new Map(); // file -> { mtime, waiting }
  function waitingOn(file) {
    let mtime;
    try { mtime = fs.statSync(file).mtimeMs; } catch { return false; }
    const hit = waitCache.get(file);
    if (hit && hit.mtime === mtime) return hit.waiting;
    let waiting = false;
    try {
      const size = fs.statSync(file).size;
      const fd = fs.openSync(file, 'r');
      const len = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      fs.closeSync(fd);
      let lastWho = '', lastText = '';
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.startsWith('{"') || !(line.includes('"type":"user"') || line.includes('"type":"assistant"'))) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (e.isMeta || e.isSidechain) continue;
        const content = e.message?.content;
        if (e.type === 'user') {
          const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join(' ') : '';
          if (text && !/^\s*<(system-reminder|command|local-command|task-notification)/.test(text) && !Array.isArray(content)) lastWho = 'you';
          else if (Array.isArray(content) && content.some(c => c.type === 'tool_result')) continue; // tool results aren't the user talking
        } else if (e.type === 'assistant' && Array.isArray(content)) {
          const text = content.filter(c => c.type === 'text').map(c => c.text).join(' ').trim();
          if (content.some(c => c.type === 'tool_use')) { lastWho = 'tool'; continue; }
          if (text) { lastWho = 'claude'; lastText = text; }
        }
      }
      waiting = lastWho === 'claude' && /\?\s*$/.test(lastText.replace(/[*_`)\]]+$/g, '').trim());
    } catch {}
    waitCache.set(file, { mtime, waiting });
    return waiting;
  }

  function history(id) {
    const file = sessionFile(id);
    if (!file) return { mtime: 0, items: [] };
    const mtime = fs.statSync(file).mtimeMs;
    const items = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.startsWith('{"') || !(line.includes('"type":"user"') || line.includes('"type":"assistant"'))) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.isMeta || e.isSidechain) continue;
      const content = e.message?.content;
      if (e.type === 'user' && typeof content === 'string') {
        const text = content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
        if (!text || /^<(command|local-command)/.test(text) || text.startsWith('[Request interrupted')) continue;
        items.push({ who: 'you', text, ts: e.timestamp });
      } else if (e.type === 'assistant' && Array.isArray(content)) {
        const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n\n').trim();
        if (!text) continue;
        const last = items[items.length - 1];
        if (last?.who === 'claude') last.text += `\n\n${text}`;
        else items.push({ who: 'claude', text, ts: e.timestamp });
      }
    }
    return { mtime, items: items.slice(-200) };
  }

  // ---------- speech ----------

  function forSpeech(text) {
    return String(text)
      .replace(/```[\s\S]*?```/g, ' ')
      // Names in backticks show exactly in the captions; say just the last part of a path.
      .replace(/`([^`]+)`/g, (_, name) => name.includes('/') ? name.split('/').filter(Boolean).pop() : name)
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/https?:\/\/\S+/g, 'a link')
      .replace(/[`*_#>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function speak(text, interrupt = false) {
    if (muted) return;
    const line = forSpeech(text);
    if (!line) return;
    if (interrupt) hush();
    speech.push({ say: line, show: String(text).trim() });
    pump();
  }

  function pump() {
    if (speaker) return;
    if (!speech.length && nudges.size) {
      // Other conversations wait their turn, then get one short line each.
      for (const [id, text] of nudges) speech.push({ say: forSpeech(text), show: text, chime: true, nudge: id });
      nudges.clear();
    }
    if (process.platform !== 'darwin') { speech.length = 0; nudges.clear(); return; } // voice uses macOS `say`; elsewhere the board stays silent
    if (!speech.length) return;
    const item = speech.shift();
    const start = () => {
      const p = spawn('say', [], { stdio: ['pipe', 'ignore', 'ignore'] });
      speaker = p;
      broadcast({ kind: 'speaking', on: true, text: item.show, nudge: item.nudge || null });
      const done = () => {
        if (speaker !== p) return;
        speaker = null;
        if (speech.length || nudges.size) pump();
        else broadcast({ kind: 'speaking', on: false });
      };
      p.on('close', done);
      p.on('error', done);
      p.stdin.end(item.say);
    };
    if (item.chime) {
      speaker = true; // hold the queue while the chime plays
      const c = spawn('afplay', [CHIME], { stdio: 'ignore' });
      const go = () => { speaker = null; start(); };
      c.on('close', go);
      c.on('error', go);
    } else start();
  }
  function nudge(id, text) {
    if (muted || !text) return;
    nudges.set(id, text); // a newer nudge replaces the older one for the same conversation
    pump();
  }

  function hush() {
    nudges.clear();
    speech.length = 0;
    const p = speaker;
    speaker = null;
    p?.kill();
    broadcast({ kind: 'speaking', on: false });
  }

  // ---------- talking to claude ----------

  // The "Terminal reply" plugin setting, written here by hook.js so page-driven sessions follow it too.
  function replyMode() {
    try { return JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8')).terminalReply === 'short' ? 'short' : 'full'; } catch { return 'full'; }
  }
  function rules() {
    const line = replyMode() === 'short'
      ? 'Terminal reply: short. Your text reply is just one or two sentences pointing at the board.'
      : 'Terminal reply: full. Give your normal, complete text answer as well; the board visual is in addition to it, not instead of it.';
    try { return `${fs.readFileSync(RULES, 'utf8').trim()}\n\nOn this machine the board file is ${BOARD} and the block syntax is in ${VIZ}. The Glance page is at ${URL_BASE}.\n${line}`; } catch { return ''; }
  }

  function sectionLine(sessionId, cwd) {
    return `Your board section in ${BOARD} is <section id="session-${sessionId.slice(0, 8)}" data-session="${sessionId}" data-cwd="${cwd}" data-updated="<ISO time>">; keep those attributes on it.`;
  }

  function boardPrompt(sessionId, cwd) {
    return [
      'You are being driven from the Glance web page, not a terminal.',
      rules(),
      sectionLine(sessionId, cwd),
      'Put your answer on the board following those rules.',
      replyMode() === 'short' ? 'Your text reply shows in the chat panel beside the board, so keep it to one short sentence pointing at the visual.' : 'Your text reply shows in the chat panel beside the board.',
    ].join('\n');
  }

  function voicePrompt(sessionId, cwd) {
    return [
      'You are in a spoken conversation through the Glance page. The user\'s messages are transcribed speech, so expect small transcription mistakes.',
      'Everything you write as text is read aloud by a text-to-speech voice. Talk like a person in conversation: short natural sentences, usually one to three. No markdown, lists, or code blocks. Your words are also shown as captions, so put any file name, path, command, or exact identifier in backticks: the caption shows it exactly while the voice just says the name. If a full answer would be long, give the gist and offer more.',
      'Before work that will take a while, say one short line first so the user knows you are on it.',
      'The board rules follow, but in this spoken mode they override their HTML-first default: do not touch the board by default. Only when the user asks to see something (a visual, picture, diagram, "show me") update your board section following those rules, including the spoken data-say narration, and then just say one short line like "It\'s up on the board." The narration is read aloud for you.',
      rules(),
      sectionLine(sessionId, cwd),
    ].join('\n');
  }

  function describe(tool) {
    const input = tool.input || {};
    if (input.command) return String(input.command).slice(0, 80);
    if (input.file_path) return path.basename(String(input.file_path));
    if (input.pattern) return String(input.pattern).slice(0, 80);
    if (input.description) return String(input.description).slice(0, 80);
    return '';
  }

  // Reads claude's stream-json output, relaying progress to the page.
  function watch(child, sessionId, target, { onText, onResult }) {
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id && ev.session_id !== target) {
          aliases.set(sessionId, ev.session_id);
        } else if (ev.type === 'assistant') {
          for (const c of ev.message?.content || []) {
            if (c.type === 'tool_use') broadcast({ kind: 'tool', sessionId, name: c.name, detail: describe(c) });
            else if (c.type === 'text' && c.text) { broadcast({ kind: 'text', sessionId, text: c.text }); onText?.(c.text); }
          }
        } else if (ev.type === 'result') {
          onResult({
            kind: 'done', sessionId, isError: !!ev.is_error, text: ev.result || '',
            denials: [...new Set((ev.permission_denials || []).map(d => d.tool_name))],
          });
        }
      }
    });
  }

  function claudeArgs({ sessionId, isNew, mode, prompt, persistent }) {
    return [
      '-p', '--output-format', 'stream-json', '--verbose',
      ...(persistent ? ['--input-format', 'stream-json'] : []),
      '--permission-mode', mode, '--permission-prompts', 'none',
      '--add-dir', CLAUDE_DIR,
      '--append-system-prompt', prompt,
      isNew ? '--session-id' : '--resume', aliases.get(sessionId) || sessionId,
    ];
  }

  // Two processes on one session would make the CLI fork a copy, so close the warm voice one first.
  function closeLive(sessionId) {
    const l = live.get(sessionId);
    if (!l) return Promise.resolve();
    live.delete(sessionId);
    clearTimeout(l.timer);
    return new Promise(resolve => { l.child.once('close', resolve); l.child.stdin.end(); setTimeout(() => l.child.kill(), 3000); });
  }

  async function run({ sessionId, cwd, message, isNew, mode }) {
    running.set(sessionId, null);
    await closeLive(sessionId);
    const target = aliases.get(sessionId) || sessionId;
    const child = spawn('claude', claudeArgs({ sessionId, isNew, mode, prompt: boardPrompt(sessionId, cwd) }), { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    running.set(sessionId, child);
    broadcast({ kind: 'start', sessionId });

    let stderr = '';
    let finished = false;
    watch(child, sessionId, target, { onResult: evt => { finished = true; broadcast(evt); } });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', err => {
      running.delete(sessionId);
      finished = true;
      broadcast({ kind: 'done', sessionId, isError: true, text: `Couldn't run claude: ${err.message}` });
    });
    child.on('close', code => {
      running.delete(sessionId);
      if (!finished) broadcast({ kind: 'done', sessionId, isError: true, text: stderr.trim().split('\n').pop() || `claude stopped (exit ${code})` });
    });
    child.stdin.end(message);
  }

  async function talk({ sessionId, cwd, message, isNew, mode }) {
    running.set(sessionId, null);
    let l = live.get(sessionId);
    if (l && l.mode !== mode) { await closeLive(sessionId); l = null; }
    if (!l) {
      const target = aliases.get(sessionId) || sessionId;
      const child = spawn('claude', claudeArgs({ sessionId, isNew, mode, prompt: voicePrompt(sessionId, cwd), persistent: true }), { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      l = { child, mode, busy: false, timer: null, stderr: '' };
      const me = l;
      live.set(sessionId, l);
      watch(child, sessionId, target, {
        onText: text => speak(text),
        onResult: evt => {
          me.busy = false;
          running.delete(sessionId);
          broadcast(evt);
          me.timer = setTimeout(() => closeLive(sessionId), VOICE_IDLE_MS);
        },
      });
      child.stderr.on('data', c => { me.stderr += c; });
      child.on('error', () => {});
      child.on('close', code => {
        if (live.get(sessionId) === me) live.delete(sessionId);
        clearTimeout(me.timer);
        if (me.busy) {
          running.delete(sessionId);
          broadcast({ kind: 'done', sessionId, isError: true, text: me.stderr.trim().split('\n').pop() || `claude stopped (exit ${code})` });
        }
      });
    }
    clearTimeout(l.timer);
    l.busy = true;
    running.set(sessionId, l.child);
    broadcast({ kind: 'start', sessionId });
    l.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: message } }) + '\n');
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', c => {
        body += c;
        if (body.length > 1e6) { reject(new Error('too large')); req.destroy(); }
      });
      req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
  }

  function send(res, status, body, type = 'application/json') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  }

  function resolveDir(dir) {
    const full = path.resolve(String(dir || '~').replace(/^~(?=$|\/)/, HOME));
    try { return fs.statSync(full).isDirectory() ? full : null; } catch { return null; }
  }

  const server = http.createServer(async (req, res) => {
    // Only answer requests addressed to localhost (blocks DNS-rebinding pages).
    if (!allowedHosts.has(req.headers.host)) return send(res, 403, { error: 'forbidden' });
    const url = new URL(req.url, URL_BASE);

    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });

    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, fs.readFileSync(UI, 'utf8').replace('__BOARD_TOKEN__', token), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && url.pathname.startsWith('/board/')) {
      const name = url.pathname.slice('/board/'.length);
      const type = STATIC[name];
      if (!type) return send(res, 404, { error: 'not found' });
      try { return send(res, 200, fs.readFileSync(path.join(__dirname, name)), type); } catch { return send(res, 404, { error: 'not found' }); }
    }

    if (req.method === 'GET' && url.pathname === '/board.html') {
      let html = '';
      try { html = fs.readFileSync(BOARD, 'utf8'); } catch {}
      return send(res, 200, html, 'text/html; charset=utf-8');
    }

    // Everything below can run commands, so it needs the token that only the served page knows.
    const authed = url.searchParams.get('token') === token || req.headers['x-board-token'] === token;
    if (!authed) return send(res, 403, { error: 'forbidden' });

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ kind: 'hello', running: [...running.keys()], speaking: !!speaker, muted })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/boards') {
      const list = [...latest.entries()].map(([id, m]) => {
        const file = sessionFile(aliases.get(id) || id);
        const waiting = !!file && !running.has(id) && !live.get(id)?.busy && waitingOn(file);
        return { id, cwd: m.cwd, updated: m.updated, ts: m.ts, title: m.title, count: m.count, say: m.say, update: m.update, waiting };
      });
      list.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
      return send(res, 200, list);
    }

    if (req.method === 'GET' && url.pathname === '/visuals') {
      const id = (url.searchParams.get('session') || '').toLowerCase();
      if (!UUID.test(id)) return send(res, 400, { error: 'Bad session id' });
      const limit = Math.min(Number(url.searchParams.get('limit')) || 30, 200);
      const kept = [];
      for (const e of readHistory(id)) { if (e.rev && kept.length) kept[kept.length - 1] = e; else kept.push(e); }
      return send(res, 200, kept.reverse().slice(0, limit).map(e => ({ ts: e.ts, html: e.html })));
    }

    if (req.method === 'GET' && url.pathname === '/sessions') {
      try { return send(res, 200, recentSessions()); } catch (e) { return send(res, 500, { error: e.message }); }
    }

    if (req.method === 'GET' && url.pathname === '/history') {
      const id = url.searchParams.get('session') || '';
      if (!UUID.test(id)) return send(res, 400, { error: 'Bad session id' });
      const real = aliases.get(id) || id;
      const file = sessionFile(real);
      const mtime = file ? fs.statSync(file).mtimeMs : 0;
      if (String(mtime) === url.searchParams.get('since')) return send(res, 200, { same: true });
      return send(res, 200, history(real));
    }

    if (req.method === 'POST' && url.pathname === '/send') {
      let body;
      try { body = await readJson(req); } catch { return send(res, 400, { error: 'bad request' }); }
      const message = String(body.message || '').trim();
      const mode = MODES.has(body.mode) ? body.mode : 'auto';
      const isNew = !body.sessionId;
      const sessionId = isNew ? crypto.randomUUID() : String(body.sessionId);
      const cwd = resolveDir(body.cwd);
      if (!message) return send(res, 400, { error: 'Empty message' });
      if (!UUID.test(sessionId)) return send(res, 400, { error: 'Bad session id' });
      if (!cwd) return send(res, 400, { error: `Folder not found: ${body.cwd}` });
      if (running.has(sessionId)) return send(res, 409, { error: 'That session is still working' });
      (body.voice ? talk : run)({ sessionId, cwd, message, isNew, mode });
      return send(res, 200, { sessionId, cwd });
    }

    if (req.method === 'POST' && url.pathname === '/speak') {
      let body;
      try { body = await readJson(req); } catch { return send(res, 400, { error: 'bad request' }); }
      const text = String(body.text || '').trim().slice(0, 4000);
      const key = String(body.key || '');
      // Several open tabs report the same change; only say each narration once unless asked again.
      if (text && (body.force || spoken.get(key) !== text)) {
        spoken.set(key, text);
        speak(text, !!body.force);
      }
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/nudge') {
      let body;
      try { body = await readJson(req); } catch { return send(res, 400, { error: 'bad request' }); }
      nudge(String(body.id || ''), String(body.text || '').trim().slice(0, 200));
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/mute') {
      let body;
      try { body = await readJson(req); } catch { return send(res, 400, { error: 'bad request' }); }
      muted = !!body.on;
      if (muted) hush();
      broadcast({ kind: 'muted', on: muted });
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/hush') {
      hush();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/stop') {
      let body;
      try { body = await readJson(req); } catch { return send(res, 400, { error: 'bad request' }); }
      const id = String(body.sessionId);
      if (live.has(id)) closeLive(id);
      running.get(id)?.kill('SIGINT');
      hush();
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'not found' });
  });

  server.listen(PORT, '127.0.0.1', () => console.log(`Glance serving ${URL_BASE}`));
}
