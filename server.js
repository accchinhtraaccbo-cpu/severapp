/**
 * AppLock Remote Control Server
 * Pure Node.js — zero external dependencies
 * Devices register via HTTP REST, dashboard polls for updates
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// ─────────────────────────────────────────────────
// In-memory store
// ─────────────────────────────────────────────────
const devices = new Map();
// Map<deviceId, {
//   deviceId, deviceName, androidVersion, model,
//   brand, lastSeen, apps: Map<packageName, AppEntry>
// }>
// AppEntry: { packageName, label, isSystem, isGame, locked, icon(base64?) }

const pendingCommands = new Map();
// Map<deviceId, Array<{cmdId, action:'lock'|'unlock', packageName}>>

// ─────────────────────────────────────────────────
// Tiny router
// ─────────────────────────────────────────────────
const routes = [];
function route(method, pattern, handler) {
  routes.push({ method: method.toUpperCase(), pattern, handler });
}

function matchRoute(method, url) {
  for (const r of routes) {
    if (r.method !== method) continue;
    if (typeof r.pattern === 'string') {
      if (url === r.pattern || url.startsWith(r.pattern + '?')) {
        return { handler: r.handler, params: {} };
      }
    } else if (r.pattern instanceof RegExp) {
      const m = url.match(r.pattern);
      if (m) return { handler: r.handler, params: m.groups || {} };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch { reject(new Error('Bad JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, contentType = 'application/json') {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(data);
}

function getQuery(url) {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const params = {};
  new URLSearchParams(url.slice(idx + 1)).forEach((v, k) => params[k] = v);
  return params;
}

function timestamp() {
  return new Date().toISOString();
}

// ─────────────────────────────────────────────────
// API Routes — Android client
// ─────────────────────────────────────────────────

// POST /api/device/register
// Body: { deviceName, model, brand, androidVersion, apps:[{packageName,label,isSystem,isGame,locked,icon}] }
route('POST', '/api/device/register', async (req, res) => {
  let body;
  try { body = await parseBody(req); }
  catch { return send(res, 400, { error: 'Bad JSON' }); }

  const { deviceName, model, brand, androidVersion, apps = [] } = body;
  if (!deviceName) return send(res, 400, { error: 'deviceName required' });

  // Find existing device by name+model or create new
  let deviceId = null;
  for (const [id, d] of devices) {
    if (d.deviceName === deviceName && d.model === (model || '')) {
      deviceId = id;
      break;
    }
  }
  if (!deviceId) deviceId = randomUUID();

  const appMap = new Map();
  for (const a of apps) {
    appMap.set(a.packageName, {
      packageName: a.packageName,
      label:       a.label || a.packageName,
      isSystem:    !!a.isSystem,
      isGame:      !!a.isGame,
      locked:      !!a.locked,
      icon:        a.icon || null,
    });
  }

  devices.set(deviceId, {
    deviceId,
    deviceName:     deviceName,
    model:          model || 'Unknown',
    brand:          brand || 'Unknown',
    androidVersion: androidVersion || 'Unknown',
    lastSeen:       timestamp(),
    apps:           appMap,
  });

  if (!pendingCommands.has(deviceId)) pendingCommands.set(deviceId, []);

  console.log(`[REGISTER] ${deviceName} (${deviceId}) — ${apps.length} apps`);
  send(res, 200, { deviceId, message: 'Registered' });
});

// POST /api/device/heartbeat
// Body: { deviceId }  — just updates lastSeen
route('POST', '/api/device/heartbeat', async (req, res) => {
  let body;
  try { body = await parseBody(req); }
  catch { return send(res, 400, { error: 'Bad JSON' }); }

  const d = devices.get(body.deviceId);
  if (!d) return send(res, 404, { error: 'Device not found' });
  d.lastSeen = timestamp();
  send(res, 200, { ok: true });
});

// POST /api/device/sync-apps
// Body: { deviceId, apps:[...] } — full app list sync
route('POST', '/api/device/sync-apps', async (req, res) => {
  let body;
  try { body = await parseBody(req); }
  catch { return send(res, 400, { error: 'Bad JSON' }); }

  const d = devices.get(body.deviceId);
  if (!d) return send(res, 404, { error: 'Device not found' });

  for (const a of (body.apps || [])) {
    d.apps.set(a.packageName, {
      packageName: a.packageName,
      label:       a.label || a.packageName,
      isSystem:    !!a.isSystem,
      isGame:      !!a.isGame,
      locked:      !!a.locked,
      icon:        a.icon || null,
    });
  }
  d.lastSeen = timestamp();
  send(res, 200, { ok: true });
});

// GET /api/device/poll-commands?deviceId=xxx
// Android polls this to get pending lock/unlock commands
route('GET', '/api/device/poll-commands', (req, res) => {
  const { deviceId } = getQuery(req.url);
  if (!deviceId) return send(res, 400, { error: 'deviceId required' });

  const d = devices.get(deviceId);
  if (!d) return send(res, 404, { error: 'Device not found' });

  d.lastSeen = timestamp();
  const cmds = pendingCommands.get(deviceId) || [];
  pendingCommands.set(deviceId, []); // drain
  send(res, 200, { commands: cmds });
});

// POST /api/device/ack-command
// Body: { deviceId, cmdId, packageName, locked }
// Android confirms it applied a command
route('POST', '/api/device/ack-command', async (req, res) => {
  let body;
  try { body = await parseBody(req); }
  catch { return send(res, 400, { error: 'Bad JSON' }); }

  const d = devices.get(body.deviceId);
  if (!d) return send(res, 404, { error: 'Device not found' });

  const app = d.apps.get(body.packageName);
  if (app) app.locked = !!body.locked;
  d.lastSeen = timestamp();

  console.log(`[ACK] ${d.deviceName} — ${body.packageName} locked=${body.locked}`);
  send(res, 200, { ok: true });
});

// ─────────────────────────────────────────────────
// API Routes — Dashboard
// ─────────────────────────────────────────────────

// GET /api/devices — list all devices
route('GET', '/api/devices', (req, res) => {
  const list = [];
  for (const [, d] of devices) {
    const appArr = [];
    for (const [, a] of d.apps) appArr.push(a);
    const online = (Date.now() - new Date(d.lastSeen).getTime()) < 60_000;
    list.push({
      deviceId:       d.deviceId,
      deviceName:     d.deviceName,
      model:          d.model,
      brand:          d.brand,
      androidVersion: d.androidVersion,
      lastSeen:       d.lastSeen,
      online,
      appCount:       d.apps.size,
      lockedCount:    appArr.filter(a => a.locked).length,
      apps:           appArr,
    });
  }
  send(res, 200, list);
});

// GET /api/devices/:deviceId/apps
route('GET', /^\/api\/devices\/(?<deviceId>[^/?]+)\/apps/, (req, res) => {
  const { deviceId } = matchRoute('GET', req.url.split('?')[0]).params;
  const d = devices.get(deviceId);
  if (!d) return send(res, 404, { error: 'Device not found' });
  const apps = [];
  for (const [, a] of d.apps) apps.push(a);
  send(res, 200, apps);
});

// POST /api/devices/:deviceId/command
// Body: { action: 'lock'|'unlock', packageName }
route('POST', /^\/api\/devices\/(?<deviceId>[^/?]+)\/command/, async (req, res) => {
  const urlPath = req.url.split('?')[0];
  const m = urlPath.match(/^\/api\/devices\/([^/?]+)\/command/);
  const deviceId = m ? m[1] : null;
  if (!deviceId) return send(res, 400, { error: 'Bad URL' });

  let body;
  try { body = await parseBody(req); }
  catch { return send(res, 400, { error: 'Bad JSON' }); }

  const d = devices.get(deviceId);
  if (!d) return send(res, 404, { error: 'Device not found' });

  const { action, packageName, password } = body;
  if (!action || !packageName) return send(res, 400, { error: 'action and packageName required' });
  if (action !== 'lock' && action !== 'unlock') return send(res, 400, { error: 'action must be lock or unlock' });
  if (action === 'lock' && (!password || String(password).trim().length < 4))
    return send(res, 400, { error: 'password required (min 4 chars) for lock' });

  const cmdId = randomUUID();
  const queue = pendingCommands.get(deviceId) || [];
  queue.push({ cmdId, action, packageName, password: password ? String(password).trim() : '' });
  pendingCommands.set(deviceId, queue);

  // Optimistic update in server state
  const app = d.apps.get(packageName);
  if (app) app.locked = (action === 'lock');

  console.log(`[CMD] ${action.toUpperCase()} ${packageName} → ${d.deviceName}`);
  send(res, 200, { cmdId, queued: true });
});

// ─────────────────────────────────────────────────
// Dashboard HTML (served at /)
// ─────────────────────────────────────────────────
route('GET', '/', (req, res) => {
  send(res, 200, getDashboardHTML(), 'text/html; charset=utf-8');
});

// ─────────────────────────────────────────────────
// HTTP Server
// ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  // Keep-alive header để tránh 502
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=30');

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Connection': 'keep-alive',
    });
    return res.end();
  }

  // Timeout per request (25s) để tránh treo
  const reqTimeout = setTimeout(() => {
    if (!res.headersSent) {
      send(res, 503, { error: 'Request timeout' });
    }
  }, 25000);

  const urlPath = req.url.split('?')[0];
  const matched = matchRoute(req.method, urlPath) || matchRoute(req.method, req.url);
  try {
    if (matched) {
      await matched.handler(req, res);
    } else {
      send(res, 404, { error: 'Not found' });
    }
  } catch (e) {
    console.error('[ERROR]', e.message);
    if (!res.headersSent) {
      send(res, 500, { error: 'Internal server error' });
    }
  } finally {
    clearTimeout(reqTimeout);
  }
});

// Keep-alive & timeout settings cho server
server.keepAliveTimeout = 30000;
server.headersTimeout   = 35000;
server.timeout          = 60000;

// Xử lý lỗi server không crash
server.on('error', (err) => {
  console.error('[SERVER ERROR]', err.message);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[SIGTERM] Shutting down gracefully...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000);
});
process.on('SIGINT', () => {
  console.log('[SIGINT] Shutting down...');
  server.close(() => process.exit(0));
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err.message);
  // Không exit — giữ server sống
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🔒 AppLock Remote Server running at http://0.0.0.0:${PORT}`);
  console.log(`   Dashboard → http://localhost:${PORT}`);
  console.log(`   Android endpoint → POST http://<YOUR_IP>:${PORT}/api/device/register\n`);
  startSelfPing();
});

// ─────────────────────────────────────────────────
// Self-ping — giữ server sống 24/24 trên Render free
// Ping chính mình mỗi 5 phút để không bị spin down
// ─────────────────────────────────────────────────
function startSelfPing() {
  const PING_INTERVAL = 4 * 60 * 1000; // 4 phút (Render free spin-down sau 5 phút)

  const selfUrl = process.env.RENDER_EXTERNAL_URL
               || process.env.APP_URL
               || `http://localhost:${PORT}`;

  // Chọn đúng module http/https theo URL
  const https = require('https');
  const httpModule = selfUrl.startsWith('https') ? https : http;

  function doPing() {
    const target = `${selfUrl}/api/ping`;
    const req = httpModule.get(target, (res) => {
      console.log(`[PING] ${new Date().toISOString()} → ${target} (${res.statusCode})`);
      res.resume();
    });
    req.on('error', (err) => {
      console.warn(`[PING] Lỗi ping: ${err.message} — retry in 30s`);
      // Retry sau 30s nếu lỗi
      setTimeout(doPing, 30000);
    });
    req.setTimeout(10000, () => {
      req.destroy();
      console.warn('[PING] Timeout — retry in 30s');
      setTimeout(doPing, 30000);
    });
  }

  setInterval(doPing, PING_INTERVAL);
  // Ping lần đầu sau 10s khi server đã ổn định
  setTimeout(doPing, 10000);

  console.log(`[PING] Self-ping mỗi 4 phút → ${selfUrl}/api/ping`);
}

// GET /api/ping — endpoint cho self-ping (và uptime monitor bên ngoài)
route('GET', '/api/ping', (req, res) => {
  send(res, 200, { ok: true, time: new Date().toISOString(), uptime: Math.floor(process.uptime()) });
});

// ─────────────────────────────────────────────────
// Dashboard HTML — all inline, zero dependencies
// ─────────────────────────────────────────────────
function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AppLock Dashboard</title>
<style>
  :root {
    --bg:        #0D1117;
    --surface:   #161B22;
    --card:      #1C2230;
    --card-lock: #1A2744;
    --accent:    #4F8EF7;
    --red:       #E53935;
    --green:     #43A047;
    --amber:     #FFAB40;
    --text:      #E6EDF3;
    --sub:       #8B949E;
    --divider:   #21262D;
    --online:    #26A641;
    --offline:   #484F58;
    --radius-sm: 8px;
    --radius-md: 14px;
    --radius-lg: 20px;
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    min-height: 100vh;
  }

  /* ── Header ── */
  header {
    background: linear-gradient(135deg, #1565C0 0%, #0D47A1 60%, #1A1F35 100%);
    padding: 24px 32px 20px;
    display: flex;
    align-items: center;
    gap: 16px;
    border-bottom: 1px solid #1e3a5f;
  }
  header .logo { font-size: 32px; }
  header h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.3px; }
  header p  { font-size: 13px; color: rgba(255,255,255,.65); margin-top: 2px; }
  header .hdr-right { margin-left: auto; display: flex; gap: 12px; align-items: center; }
  .pill {
    background: rgba(255,255,255,.1);
    border: 1px solid rgba(255,255,255,.15);
    border-radius: 999px;
    padding: 5px 14px;
    font-size: 12px;
    font-weight: 600;
    color: #fff;
  }

  /* ── Layout ── */
  .layout {
    display: grid;
    grid-template-columns: 320px 1fr;
    height: calc(100vh - 84px);
  }

  /* ── Device sidebar ── */
  .sidebar {
    border-right: 1px solid var(--divider);
    background: var(--surface);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .sidebar-header {
    padding: 16px 20px 12px;
    border-bottom: 1px solid var(--divider);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 1px;
    color: var(--sub);
    text-transform: uppercase;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .refresh-btn {
    background: none;
    border: 1px solid var(--divider);
    border-radius: 6px;
    color: var(--sub);
    padding: 3px 9px;
    font-size: 11px;
    cursor: pointer;
    transition: all .15s;
  }
  .refresh-btn:hover { border-color: var(--accent); color: var(--accent); }

  .device-card {
    padding: 14px 20px;
    border-bottom: 1px solid var(--divider);
    cursor: pointer;
    transition: background .12s;
    position: relative;
  }
  .device-card:hover  { background: rgba(79,142,247,.06); }
  .device-card.active { background: rgba(79,142,247,.12); border-left: 3px solid var(--accent); }

  .device-name {
    font-size: 14px;
    font-weight: 700;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .status-dot.online  { background: var(--online); box-shadow: 0 0 6px var(--online); }
  .status-dot.offline { background: var(--offline); }

  .device-meta {
    font-size: 11px;
    color: var(--sub);
    margin-top: 4px;
    line-height: 1.5;
  }
  .device-badges {
    display: flex;
    gap: 6px;
    margin-top: 8px;
    flex-wrap: wrap;
  }
  .badge {
    font-size: 10px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 999px;
  }
  .badge-android { background: rgba(79,142,247,.15); color: var(--accent); border: 1px solid rgba(79,142,247,.3); }
  .badge-locked  { background: rgba(229,57,53,.15);  color: var(--red);    border: 1px solid rgba(229,57,53,.3);  }
  .badge-total   { background: rgba(139,148,158,.1);  color: var(--sub);   border: 1px solid var(--divider); }

  .empty-devices {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--sub);
    font-size: 13px;
    gap: 12px;
    padding: 40px;
    text-align: center;
  }
  .empty-devices .icon { font-size: 48px; opacity: .4; }

  /* ── Main panel ── */
  .main {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── App toolbar ── */
  .toolbar {
    padding: 16px 24px 12px;
    border-bottom: 1px solid var(--divider);
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
    background: var(--surface);
  }
  .device-title { font-size: 18px; font-weight: 700; flex: 1; min-width: 200px; }
  .device-info-text { font-size: 12px; color: var(--sub); margin-top: 2px; }

  .search-box {
    background: var(--card);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    color: var(--text);
    padding: 7px 12px;
    font-size: 13px;
    width: 200px;
    outline: none;
    transition: border-color .15s;
  }
  .search-box:focus { border-color: var(--accent); }

  .tab-bar {
    display: flex;
    gap: 4px;
    padding: 12px 24px 0;
    border-bottom: 1px solid var(--divider);
    background: var(--surface);
  }
  .tab {
    padding: 7px 16px;
    border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    color: var(--sub);
    border: none;
    background: none;
    border-bottom: 2px solid transparent;
    transition: all .15s;
    margin-bottom: -1px;
  }
  .tab:hover  { color: var(--text); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .tab-locked.active { color: var(--red) !important; border-bottom-color: var(--red) !important; }

  .stat-strip {
    padding: 8px 24px;
    font-size: 12px;
    color: var(--sub);
    background: var(--surface);
    border-bottom: 1px solid var(--divider);
    display: flex;
    gap: 20px;
  }
  .stat-strip span b { color: var(--text); }

  /* ── App list ── */
  .app-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px 16px 24px;
  }

  .app-row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 14px;
    border-radius: var(--radius-md);
    margin-bottom: 6px;
    transition: background .12s;
    border: 1px solid transparent;
  }
  .app-row:hover { background: rgba(255,255,255,.03); }
  .app-row.locked-row {
    background: var(--card-lock);
    border-color: rgba(79,142,247,.12);
  }
  .app-row.locked-row:hover { background: #1e2e55; }

  .app-icon-wrap {
    width: 46px; height: 46px;
    border-radius: 12px;
    background: #1E2840;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    font-size: 22px;
    overflow: hidden;
  }
  .app-icon-wrap img { width: 100%; height: 100%; object-fit: contain; border-radius: 10px; }

  .app-info { flex: 1; min-width: 0; }
  .app-name {
    font-size: 14px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .app-pkg {
    font-size: 10px;
    color: var(--sub);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 2px;
  }
  .app-tags { display: flex; gap: 4px; margin-top: 4px; }
  .tag {
    font-size: 9px;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 4px;
    letter-spacing: .3px;
  }
  .tag-sys  { background: rgba(255,171,64,.12); color: var(--amber); }
  .tag-game { background: rgba(79,142,247,.12); color: var(--accent); }

  .app-right { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex-shrink: 0; }
  .lock-status {
    font-size: 10px;
    font-weight: 700;
    padding: 2px 9px;
    border-radius: 999px;
  }
  .lock-status.locked  { background: rgba(229,57,53,.15);  color: var(--red);   }
  .lock-status.unlocked{ background: rgba(67,160,71,.15);  color: var(--green); }

  .action-btn {
    padding: 6px 16px;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 700;
    border: none;
    cursor: pointer;
    transition: opacity .15s, transform .1s;
    min-width: 80px;
    text-align: center;
  }
  .action-btn:hover   { opacity: .85; transform: scale(.97); }
  .action-btn:active  { transform: scale(.94); }
  .action-btn.do-lock   { background: var(--red);   color: #fff; }
  .action-btn.do-unlock { background: var(--green); color: #fff; }
  .action-btn.pending   { background: var(--divider); color: var(--sub); cursor: wait; }

  /* ── No device selected ── */
  .no-device {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--sub);
    gap: 16px;
  }
  .no-device .big-icon { font-size: 72px; opacity: .2; }
  .no-device h2 { font-size: 20px; font-weight: 700; color: var(--text); opacity: .4; }
  .no-device p  { font-size: 13px; max-width: 320px; text-align: center; line-height: 1.6; }

  /* ── Toast ── */
  #toast {
    position: fixed;
    bottom: 28px;
    right: 28px;
    background: var(--card);
    border: 1px solid var(--divider);
    border-radius: var(--radius-md);
    padding: 12px 20px;
    font-size: 13px;
    color: var(--text);
    box-shadow: 0 8px 32px rgba(0,0,0,.5);
    transform: translateY(80px);
    opacity: 0;
    transition: all .3s;
    z-index: 9999;
    max-width: 300px;
  }
  #toast.show { transform: translateY(0); opacity: 1; }
  #toast.toast-ok  { border-left: 3px solid var(--green); }
  #toast.toast-err { border-left: 3px solid var(--red); }

  /* ── Scrollbar ── */
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--divider); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: #3b4250; }

  /* ── Password Modal ── */
  .modal-backdrop {
    position: fixed; inset: 0;
    background: rgba(0,0,0,.65);
    display: flex; align-items: center; justify-content: center;
    z-index: 10000;
    animation: fadeIn .15s ease;
  }
  @keyframes fadeIn { from { opacity:0 } to { opacity:1 } }
  .modal-box {
    background: var(--card);
    border: 1px solid rgba(79,142,247,.25);
    border-radius: var(--radius-lg);
    padding: 28px 28px 22px;
    width: 340px;
    max-width: 92vw;
    box-shadow: 0 20px 60px rgba(0,0,0,.6);
    animation: slideUp .18s ease;
  }
  @keyframes slideUp { from { transform:translateY(20px);opacity:0 } to { transform:translateY(0);opacity:1 } }
  .modal-icon-row {
    display: flex; align-items: center; gap: 12px;
    margin-bottom: 16px;
  }
  .modal-app-icon {
    width: 48px; height: 48px; border-radius: 12px;
    background: #1E2840;
    display:flex; align-items:center; justify-content:center;
    font-size: 22px; font-weight: 700; color: #fff; flex-shrink:0;
  }
  .modal-app-name { font-size: 16px; font-weight: 700; color: var(--text); }
  .modal-action-label { font-size: 12px; color: var(--red); font-weight: 600; margin-top: 2px; }
  .modal-label {
    font-size: 12px; color: var(--sub);
    margin-bottom: 8px; margin-top: 4px;
  }
  .modal-input {
    width: 100%;
    background: var(--surface);
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 18px;
    padding: 12px 14px;
    outline: none;
    text-align: center;
    letter-spacing: 4px;
    margin-bottom: 6px;
  }
  .modal-input:focus { border-color: #82b0ff; box-shadow: 0 0 0 3px rgba(79,142,247,.15); }
  .modal-err {
    font-size: 11px; color: var(--red);
    min-height: 16px; margin-bottom: 14px; text-align:center;
  }
  .modal-footer { display: flex; gap: 10px; justify-content: flex-end; margin-top: 4px; }
  .modal-btn {
    padding: 9px 22px; border-radius: var(--radius-sm);
    font-size: 13px; font-weight: 700; border: none; cursor: pointer;
    transition: opacity .15s;
  }
  .modal-btn:hover { opacity: .85; }
  .modal-btn.cancel { background: var(--surface); color: var(--sub); border: 1px solid var(--divider); }
  .modal-btn.confirm { background: var(--red); color: #fff; }

  /* ── API hint ── */
  .api-hint {
    background: rgba(79,142,247,.06);
    border: 1px solid rgba(79,142,247,.15);
    border-radius: var(--radius-md);
    padding: 16px 20px;
    margin: 20px 24px;
    font-size: 12px;
    color: var(--sub);
    line-height: 1.7;
  }
  .api-hint b { color: var(--accent); font-family: monospace; font-size: 11px; }
  .api-hint h3 { color: var(--text); margin-bottom: 8px; font-size: 13px; }

  @media (max-width: 700px) {
    .layout { grid-template-columns: 1fr; }
    .sidebar { max-height: 40vh; }
  }
</style>
</head>
<body>

<header>
  <span class="logo">🔒</span>
  <div>
    <h1>AppLock Remote Control</h1>
    <p>Khóa &amp; mở khóa ứng dụng từ xa trên thiết bị Android</p>
  </div>
  <div class="hdr-right">
    <span class="pill" id="device-count">0 thiết bị</span>
    <span class="pill" id="last-refresh">—</span>
  </div>
</header>

<div class="layout">
  <!-- Sidebar -->
  <aside class="sidebar">
    <div class="sidebar-header">
      Thiết bị
      <button class="refresh-btn" onclick="loadDevices()">↻ Làm mới</button>
    </div>
    <div id="device-list">
      <div class="empty-devices">
        <span class="icon">📱</span>
        <span>Chưa có thiết bị.<br/>Cài app trên điện thoại Android và đăng ký với server này.</span>
      </div>
    </div>
  </aside>

  <!-- Main panel -->
  <main class="main" id="main-panel">
    <div class="no-device">
      <span class="big-icon">🛡️</span>
      <h2>Chọn thiết bị</h2>
      <p>Chọn một thiết bị ở bên trái để xem và điều khiển danh sách ứng dụng của nó.</p>
    </div>
  </main>
</div>

<div id="toast"></div>
<div id="modal-root"></div>

<script>
  // ── State ──────────────────────────────────────
  let allDevices   = [];
  let activeDevice = null;
  let activeTab    = 'all';
  let searchQuery  = '';
  let pendingPkgs  = new Set(); // packages waiting for ack

  // ── API ────────────────────────────────────────
  async function api(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  // ── Load devices ───────────────────────────────
  async function loadDevices() {
    try {
      allDevices = await api('GET', '/api/devices');
      renderSidebar();
      if (activeDevice) {
        const updated = allDevices.find(d => d.deviceId === activeDevice.deviceId);
        if (updated) { activeDevice = updated; renderMain(); }
      }
      document.getElementById('device-count').textContent = allDevices.length + ' thiết bị';
      const now = new Date();
      document.getElementById('last-refresh').textContent =
        now.getHours().toString().padStart(2,'0') + ':' +
        now.getMinutes().toString().padStart(2,'0') + ':' +
        now.getSeconds().toString().padStart(2,'0');
    } catch(e) {
      console.error(e);
    }
  }

  // ── Sidebar ────────────────────────────────────
  function renderSidebar() {
    const el = document.getElementById('device-list');
    if (allDevices.length === 0) {
      el.innerHTML = \`<div class="empty-devices">
        <span class="icon">📱</span>
        <span>Chưa có thiết bị nào kết nối.<br/>Khởi động app Android và cài đặt endpoint server.</span>
      </div>\`;
      return;
    }
    el.innerHTML = allDevices.map(d => \`
      <div class="device-card \${activeDevice && activeDevice.deviceId===d.deviceId ? 'active' : ''}"
           onclick="selectDevice('\${d.deviceId}')">
        <div class="device-name">
          <span class="status-dot \${d.online ? 'online' : 'offline'}"></span>
          \${esc(d.deviceName)}
        </div>
        <div class="device-meta">
          \${esc(d.brand)} \${esc(d.model)}<br/>
          Lần cuối: \${relTime(d.lastSeen)}
        </div>
        <div class="device-badges">
          <span class="badge badge-android">Android \${esc(d.androidVersion)}</span>
          <span class="badge badge-total">\${d.appCount} app</span>
          \${d.lockedCount > 0 ? \`<span class="badge badge-locked">🔒 \${d.lockedCount} khóa</span>\` : ''}
        </div>
      </div>
    \`).join('');
  }

  function selectDevice(id) {
    activeDevice = allDevices.find(d => d.deviceId === id);
    activeTab    = 'all';
    searchQuery  = '';
    pendingPkgs.clear();
    renderSidebar();
    renderMain();
  }

  // ── Main panel ─────────────────────────────────
  function renderMain() {
    const panel = document.getElementById('main-panel');
    if (!activeDevice) {
      panel.innerHTML = \`<div class="no-device">
        <span class="big-icon">🛡️</span>
        <h2>Chọn thiết bị</h2>
        <p>Chọn một thiết bị ở bên trái để xem và điều khiển danh sách ứng dụng của nó.</p>
      </div>\`;
      return;
    }

    const d = activeDevice;
    const apps = filterApps(d.apps || []);
    const allApps = d.apps || [];
    const totalLocked = allApps.filter(a => a.locked).length;
    const onlineStatus = d.online
      ? '<span style="color:#26A641">● Online</span>'
      : '<span style="color:#484F58">● Offline</span>';

    panel.innerHTML = \`
      <div class="toolbar">
        <div style="flex:1">
          <div class="device-title">\${esc(d.deviceName)}</div>
          <div class="device-info-text">
            \${onlineStatus} &nbsp;·&nbsp;
            \${esc(d.brand)} \${esc(d.model)} &nbsp;·&nbsp;
            Android \${esc(d.androidVersion)} &nbsp;·&nbsp;
            \${d.appCount} ứng dụng
          </div>
        </div>
        <input class="search-box" type="text" placeholder="🔍 Tìm ứng dụng..."
               value="\${esc(searchQuery)}"
               oninput="searchQuery=this.value;renderMain()" />
      </div>

      <div class="tab-bar">
        \${['all','locked','user','game','sys'].map(t => \`
          <button class="tab \${t==='locked'?'tab-locked':''} \${activeTab===t?'active':''}" onclick="activeTab='\${t}';renderMain()">
            \${{all:'📱 Tất cả',locked:'🔒 Đang khóa',user:'👤 User',game:'🎮 Game',sys:'⚙️ Hệ thống'}[t]}
            \${t==='locked' && totalLocked > 0 ? \`<span style="background:var(--red);color:#fff;border-radius:999px;font-size:10px;padding:1px 6px;margin-left:4px">\${totalLocked}</span>\` : ''}
          </button>
        \`).join('')}
      </div>

      <div class="stat-strip">
        <span><b>\${allApps.length}</b> tổng</span>
        <span><b style="color:var(--red)">\${totalLocked}</b> đang khóa</span>
        <span><b>\${apps.length}</b> hiển thị</span>
      </div>

      <div class="app-list" id="app-list">
        \${apps.length === 0
          ? (activeTab === 'locked'
              ? '<div style="text-align:center;color:var(--sub);padding:60px 0;font-size:14px"><div style="font-size:48px;margin-bottom:12px;opacity:.4">🔓</div>Không có ứng dụng nào đang bị khóa</div>'
              : '<div style="text-align:center;color:var(--sub);padding:60px 0">Không tìm thấy ứng dụng</div>')
          : apps.map(a => renderAppRow(a, d.deviceId)).join('')
        }
      </div>
    \`;
  }

  function filterApps(apps) {
    return apps.filter(a => {
      if (activeTab === 'locked' && !a.locked) return false;
      if (activeTab === 'user'   && (a.isSystem || a.isGame)) return false;
      if (activeTab === 'game'   && !a.isGame) return false;
      if (activeTab === 'sys'    && !a.isSystem) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return a.label.toLowerCase().includes(q) || a.packageName.toLowerCase().includes(q);
      }
      return true;
    });
  }

  function renderAppRow(a, deviceId) {
    const isPending = pendingPkgs.has(a.packageName);
    const iconHtml = a.icon
      ? \`<img src="data:image/png;base64,\${a.icon}" alt="" />\`
      : defaultIcon(a.label);

    return \`
      <div class="app-row \${a.locked ? 'locked-row' : ''}">
        <div class="app-icon-wrap">\${iconHtml}</div>
        <div class="app-info">
          <div class="app-name">\${esc(a.label)}</div>
          <div class="app-pkg">\${esc(a.packageName)}</div>
          <div class="app-tags">
            \${a.isSystem ? '<span class="tag tag-sys">SYS</span>' : ''}
            \${a.isGame   ? '<span class="tag tag-game">GAME</span>' : ''}
          </div>
        </div>
        <div class="app-right">
          <span class="lock-status \${a.locked ? 'locked' : 'unlocked'}">
            \${a.locked ? '🔒 Đã khoá' : '🔓 Mở'}
          </span>
          \${isPending
            ? '<button class="action-btn pending">⏳ Đang gửi...</button>'
            : a.locked
              ? \`<button class="action-btn do-unlock" onclick="sendCommand('\${deviceId}','unlock','\${esc(a.packageName)}')">MỞ KHOÁ</button>\`
              : \`<button class="action-btn do-lock"   onclick="sendCommand('\${deviceId}','lock',  '\${esc(a.packageName)}')">KHOÁ</button>\`
          }
        </div>
      </div>
    \`;
  }

  function defaultIcon(label) {
    const colors = ['#4F8EF7','#E53935','#43A047','#FFAB40','#9C27B0','#00BCD4'];
    const clr = colors[(label.charCodeAt(0) || 0) % colors.length];
    const ch  = (label[0] || '?').toUpperCase();
    return \`<div style="width:100%;height:100%;background:\${clr};display:flex;
                        align-items:center;justify-content:center;border-radius:10px;
                        font-size:20px;font-weight:700;color:#fff">\${ch}</div>\`;
  }

  // ── Commands ────────────────────────────────────
  function sendCommand(deviceId, action, packageName) {
    if (action === 'lock') {
      showLockModal(deviceId, packageName);
    } else {
      doSendCommand(deviceId, action, packageName, '');
    }
  }

  function showLockModal(deviceId, packageName) {
    const app = (activeDevice.apps || []).find(a => a.packageName === packageName);
    const label = app ? app.label : packageName;

    // Icon placeholder (first letter)
    const colors = ['#4F8EF7','#E53935','#43A047','#FFAB40','#9C27B0','#00BCD4'];
    const clr = colors[(label.charCodeAt(0)||0) % colors.length];
    const ch  = (label[0]||'?').toUpperCase();

    const modalEl = document.getElementById('modal-root');
    modalEl.innerHTML = \`
      <div class="modal-backdrop" id="pw-backdrop">
        <div class="modal-box">
          <div class="modal-icon-row">
            <div class="modal-app-icon" style="background:\${clr}">\${ch}</div>
            <div>
              <div class="modal-app-name">\${esc(label)}</div>
              <div class="modal-action-label">🔒 Khóa ứng dụng</div>
            </div>
          </div>
          <div class="modal-label">Nhập mật khẩu để khóa (ít nhất 4 ký tự):</div>
          <input id="pw-input" class="modal-input" type="password"
                 inputmode="numeric" maxlength="16"
                 placeholder="••••" autocomplete="off" />
          <div class="modal-err" id="pw-err"></div>
          <div class="modal-footer">
            <button class="modal-btn cancel" onclick="closeLockModal()">Hủy</button>
            <button class="modal-btn confirm" onclick="confirmLockModal('\${esc(deviceId)}','\${esc(packageName)}')">🔒 Khóa</button>
          </div>
        </div>
      </div>
    \`;

    const inp = document.getElementById('pw-input');
    inp.focus();
    // Allow Enter key to confirm
    inp.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') confirmLockModal(deviceId, packageName);
      if (e.key === 'Escape') closeLockModal();
    });
    // Click backdrop to close
    document.getElementById('pw-backdrop').addEventListener('click', function(e) {
      if (e.target === this) closeLockModal();
    });
  }

  function closeLockModal() {
    document.getElementById('modal-root').innerHTML = '';
  }

  function confirmLockModal(deviceId, packageName) {
    const inp = document.getElementById('pw-input');
    const errEl = document.getElementById('pw-err');
    const pw = inp ? inp.value.trim() : '';
    if (pw.length < 4) {
      if (errEl) errEl.textContent = '⚠ Mật khẩu phải ít nhất 4 ký tự!';
      if (inp) inp.focus();
      return;
    }
    closeLockModal();
    doSendCommand(deviceId, 'lock', packageName, pw);
  }

  async function doSendCommand(deviceId, action, packageName, password) {
    pendingPkgs.add(packageName);
    renderMain();
    try {
      await api('POST', \`/api/devices/\${deviceId}/command\`, { action, packageName, password });
      // Optimistic UI
      const app = (activeDevice.apps || []).find(a => a.packageName === packageName);
      if (app) app.locked = (action === 'lock');
      showToast(action === 'lock' ? \`🔒 Đã gửi lệnh khóa: \${packageName}\` : \`🔓 Đã gửi lệnh mở: \${packageName}\`, 'ok');
    } catch(e) {
      showToast('❌ Lỗi gửi lệnh: ' + e.message, 'err');
    } finally {
      pendingPkgs.delete(packageName);
      renderMain();
    }
  }

  // ── Toast ───────────────────────────────────────
  let toastTimer;
  function showToast(msg, type = 'ok') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className   = 'show toast-' + type;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.className = '', 3000);
  }

  // ── Helpers ─────────────────────────────────────
  function esc(s) {
    return String(s||'')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function relTime(iso) {
    if (!iso) return '—';
    const diff = (Date.now() - new Date(iso)) / 1000;
    if (diff < 10)   return 'Vừa xong';
    if (diff < 60)   return Math.floor(diff) + 's trước';
    if (diff < 3600) return Math.floor(diff/60) + 'm trước';
    return Math.floor(diff/3600) + 'h trước';
  }

  // ── Auto-poll ────────────────────────────────────
  loadDevices();
  setInterval(loadDevices, 5000); // refresh every 5s
</script>
</body>
</html>`;
}
