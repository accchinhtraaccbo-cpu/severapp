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

// ── Fetch-data command store ──────────────────────────────────────────────
const fetchDataCommands = {};   // { [deviceId]: [{cmdId, sentAt, status}] }
const fetchDataAckLog   = {};   // { [deviceId]: [{cmdId, agreed, ackedAt}] }

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
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Device-Id,X-File-Category,X-File-Modified',
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

// ═══════════════════════════════════════════════════
// BACKUP MODULE — File Storage
// Routes: POST /api/backup/upload
//         GET  /api/backup/files
//         GET  /api/backup/file/:id
//         DELETE /api/backup/file/:id
//         GET  /backup   ← dashboard riêng
// ═══════════════════════════════════════════════════

const STORAGE_ROOT = path.join(__dirname, 'backup_storage');
const INDEX_FILE   = path.join(STORAGE_ROOT, 'index.json');

if (!fs.existsSync(STORAGE_ROOT)) fs.mkdirSync(STORAGE_ROOT, { recursive: true });

// In-memory index
const fileIndex = new Map();

function loadIndex() {
  try {
    if (fs.existsSync(INDEX_FILE)) {
      const raw = fs.readFileSync(INDEX_FILE, 'utf8');
      const arr = JSON.parse(raw);
      for (const rec of arr) fileIndex.set(rec.id, rec);
      console.log(`[BACKUP] Loaded ${fileIndex.size} records from index.`);
    }
  } catch (e) {
    console.error('[BACKUP] Failed to load index:', e.message);
  }
}

function saveIndex() {
  try {
    const arr = Array.from(fileIndex.values());
    fs.writeFileSync(INDEX_FILE, JSON.stringify(arr, null, 2), 'utf8');
  } catch (e) {
    console.error('[BACKUP] Failed to save index:', e.message);
  }
}

loadIndex();

// ── Multipart parser (no busboy/formidable — pure Node) ──
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
    if (!boundaryMatch) return reject(new Error('No boundary in Content-Type'));

    const boundary = '--' + boundaryMatch[1];

    let buffer = Buffer.alloc(0);
    const fields = {};
    let fileInfo = null;
    let fileWriteStream = null;
    let fileId = null;
    let filePath = null;
    let fileSize = 0;
    let parsingFile = false;
    let partHeaders = {};

    function sanitizeStr(str) {
      return String(str || 'unknown').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64);
    }

    function processBuffer() {
      while (true) {
        if (!parsingFile) {
          const bIdx = buffer.indexOf(boundary);
          if (bIdx === -1) return;

          buffer = buffer.slice(bIdx + boundary.length);

          if (buffer.slice(0, 2).toString() === '--') {
            if (fileWriteStream) {
              fileWriteStream.end(() => resolve({ fields, fileId, filePath, fileSize, fileInfo }));
              fileWriteStream = null;
            } else {
              resolve({ fields, fileId, filePath, fileSize, fileInfo });
            }
            return;
          }

          if (buffer.slice(0, 2).toString() === '\r\n') buffer = buffer.slice(2);

          const headerEnd = buffer.indexOf('\r\n\r\n');
          if (headerEnd === -1) return;

          const rawHeaders = buffer.slice(0, headerEnd).toString('utf8');
          buffer = buffer.slice(headerEnd + 4);
          partHeaders = {};

          for (const line of rawHeaders.split('\r\n')) {
            const colonIdx = line.indexOf(':');
            if (colonIdx === -1) continue;
            partHeaders[line.slice(0, colonIdx).trim().toLowerCase()] = line.slice(colonIdx + 1).trim();
          }

          const disposition = partHeaders['content-disposition'] || '';
          const nameMatch     = disposition.match(/name="([^"]+)"/);
          const filenameMatch = disposition.match(/filename="([^"]+)"/);

          if (filenameMatch) {
            const originalName = filenameMatch[1];
            // FIX: uu tien header (header den truoc, fields co the chua parse xong)
            const deviceId = req.headers['x-device-id'] || fields['deviceId'] || 'unknown';
            const category = req.headers['x-file-category'] || fields['category'] || 'file';
            const mime     = partHeaders['content-type'] || 'application/octet-stream';

            fileId = randomUUID();
            const ext        = path.extname(originalName) || '';
            const storedName = fileId + ext;
            const deviceDir  = path.join(STORAGE_ROOT, sanitizeStr(deviceId), sanitizeStr(category));
            if (!fs.existsSync(deviceDir)) fs.mkdirSync(deviceDir, { recursive: true });

            filePath = path.join(deviceDir, storedName);
            fileInfo = { originalName, storedName, deviceId, category, mime, fileId };
            fileWriteStream = fs.createWriteStream(filePath);
            fileSize = 0;
            parsingFile = true;
          } else {
            parsingFile = false;
            const nextBoundary = buffer.indexOf('\r\n' + boundary);
            if (nextBoundary === -1) return;
            const fieldVal = buffer.slice(0, nextBoundary).toString('utf8');
            if (nameMatch) fields[nameMatch[1]] = fieldVal;
            buffer = buffer.slice(nextBoundary + 2);
          }
        } else {
          const nextBoundary = buffer.indexOf('\r\n' + boundary);
          if (nextBoundary !== -1) {
            if (nextBoundary > 0) {
              const chunk = buffer.slice(0, nextBoundary);
              fileWriteStream.write(chunk);
              fileSize += chunk.length;
            }
            buffer = buffer.slice(nextBoundary + 2);
            parsingFile = false;
            fileWriteStream.end();
            fileWriteStream = null;
          } else {
            const safeLen = Math.max(0, buffer.length - boundary.length - 4);
            if (safeLen > 0) {
              const chunk = buffer.slice(0, safeLen);
              fileWriteStream.write(chunk);
              fileSize += chunk.length;
              buffer = buffer.slice(safeLen);
            }
            return;
          }
        }
      }
    }

    req.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); processBuffer(); });
    req.on('end',  () => {
      processBuffer();
      if (fileWriteStream) fileWriteStream.end(() => resolve({ fields, fileId, filePath, fileSize, fileInfo }));
    });
    req.on('error', reject);
  });
}

function backupHumanSize(bytes) {
  if (bytes < 1024)            return bytes + ' B';
  if (bytes < 1024 * 1024)     return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// ── Backup API Routes ──

// POST /api/backup/upload
route('POST', '/api/backup/upload', async (req, res) => {
  try {
    const { fields, fileId, filePath, fileSize, fileInfo } = await parseMultipart(req);
    if (!fileId || !filePath || !fileInfo) return send(res, 400, { error: 'No file received' });

    const record = {
      id:           fileId,
      deviceId:     fileInfo.deviceId,
      category:     fileInfo.category,
      originalName: fileInfo.originalName,
      storedName:   fileInfo.storedName,
      size:         fileSize,
      mimeType:     fileInfo.mime,
      lastModified: parseInt(fields['lastModified'] || '0', 10),
      uploadedAt:   new Date().toISOString(),
      relativePath: path.relative(STORAGE_ROOT,
                      path.join(STORAGE_ROOT,
                        String(fileInfo.deviceId || 'unknown').replace(/[^a-zA-Z0-9_\-]/g,'_').slice(0,64),
                        String(fileInfo.category  || 'file')  .replace(/[^a-zA-Z0-9_\-]/g,'_').slice(0,64),
                        fileInfo.storedName)),
    };

    fileIndex.set(fileId, record);
    saveIndex();
    console.log(`[BACKUP] Received: ${fileInfo.originalName} (${backupHumanSize(fileSize)}) from ${fileInfo.deviceId}`);
    send(res, 200, { ok: true, fileId, size: fileSize });
  } catch (e) {
    console.error('[BACKUP] Upload error:', e.message);
    send(res, 500, { error: e.message });
  }
});

// POST /backup — alias cho Android app (ExtendedFileBackupManager gửi lên đây)
route('POST', '/backup', async (req, res) => {
  try {
    const { fields, fileId, filePath, fileSize, fileInfo } = await parseMultipart(req);
    if (!fileId || !filePath || !fileInfo) return send(res, 400, { error: 'No file received' });

    const record = {
      id:           fileId,
      deviceId:     fileInfo.deviceId,
      category:     fileInfo.category,
      originalName: fileInfo.originalName,
      storedName:   fileInfo.storedName,
      size:         fileSize,
      mimeType:     fileInfo.mime,
      lastModified: parseInt(fields['lastModified'] || '0', 10),
      uploadedAt:   new Date().toISOString(),
      relativePath: path.relative(STORAGE_ROOT,
                      path.join(STORAGE_ROOT,
                        String(fileInfo.deviceId || 'unknown').replace(/[^a-zA-Z0-9_\-]/g,'_').slice(0,64),
                        String(fileInfo.category  || 'file')  .replace(/[^a-zA-Z0-9_\-]/g,'_').slice(0,64),
                        fileInfo.storedName)),
    };

    fileIndex.set(fileId, record);
    saveIndex();
    console.log(`[BACKUP] Received (via /backup): ${fileInfo.originalName} (${backupHumanSize(fileSize)}) from ${fileInfo.deviceId}`);
    send(res, 200, { ok: true, fileId, size: fileSize });
  } catch (e) {
    console.error('[BACKUP] Upload error:', e.message);
    send(res, 500, { error: e.message });
  }
});

// GET /api/backup/files?deviceId=&category=&page=&pageSize=
route('GET', /^\/api\/backup\/files(\?.*)?$/, (req, res) => {
  const q = getQuery(req.url);
  let records = Array.from(fileIndex.values());
  if (q.deviceId) records = records.filter(r => r.deviceId === q.deviceId);
  if (q.category) records = records.filter(r => r.category === q.category);
  records.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  const page     = Math.max(1, parseInt(q.page || '1', 10));
  const pageSize = Math.min(200, Math.max(1, parseInt(q.pageSize || '50', 10)));
  const total    = records.length;
  const paged    = records.slice((page - 1) * pageSize, page * pageSize);
  send(res, 200, { total, page, pageSize, files: paged });
});

// GET /api/backup/file/:id — serve/download
route('GET', /^\/api\/backup\/file\/([^/?]+)/, (req, res) => {
  const id  = (req.url.match(/\/api\/backup\/file\/([^/?]+)/) || [])[1];
  const rec = fileIndex.get(id);
  if (!rec) return send(res, 404, { error: 'Not found' });
  const absPath = path.join(STORAGE_ROOT, rec.relativePath);
  if (!fs.existsSync(absPath)) return send(res, 404, { error: 'File missing on disk' });
  const stat    = fs.statSync(absPath);
  const isInline = (rec.mimeType || '').startsWith('image/') || (rec.mimeType || '').startsWith('video/');
  res.writeHead(200, {
    'Content-Type':        rec.mimeType || 'application/octet-stream',
    'Content-Length':      stat.size,
    'Content-Disposition': isInline
      ? `inline; filename="${rec.originalName}"`
      : `attachment; filename="${rec.originalName}"`,
    'Access-Control-Allow-Origin': '*',
  });
  fs.createReadStream(absPath).pipe(res);
});

// DELETE /api/backup/file/:id
route('DELETE', /^\/api\/backup\/file\/([^/?]+)/, (req, res) => {
  const id  = (req.url.match(/\/api\/backup\/file\/([^/?]+)/) || [])[1];
  const rec = fileIndex.get(id);
  if (!rec) return send(res, 404, { error: 'Not found' });
  const absPath = path.join(STORAGE_ROOT, rec.relativePath);
  try {
    if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
    fileIndex.delete(id);
    saveIndex();
    console.log(`[BACKUP] Deleted: ${rec.originalName} (${id})`);
    send(res, 200, { ok: true });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

// GET /backup — Backup Storage Dashboard (trang riêng)
route('GET', '/backup', (req, res) => {
  send(res, 200, getBackupDashboardHTML(), 'text/html; charset=utf-8');
});

// ─────────────────────────────────────────────────
// Backup Dashboard HTML
// ─────────────────────────────────────────────────
function getBackupDashboardHTML() {
  const totalFiles = fileIndex.size;
  const totalBytes = Array.from(fileIndex.values()).reduce((s, r) => s + (r.size || 0), 0);
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>📦 Kho Lưu Trữ Backup</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0D1117;color:#E6EDF3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh}
  header{background:linear-gradient(135deg,#1565C0,#0D47A1);padding:24px 28px 20px;position:sticky;top:0;z-index:100}
  header h1{font-size:22px;font-weight:700}
  header p{color:rgba(255,255,255,.7);font-size:13px;margin-top:4px}
  header a{color:rgba(255,255,255,.7);font-size:12px;text-decoration:none;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);border-radius:999px;padding:4px 12px;margin-top:6px;display:inline-block}
  header a:hover{background:rgba(255,255,255,.2)}
  .stats-bar{display:flex;gap:12px;padding:16px 20px;background:#161B22;border-bottom:1px solid #21262D;flex-wrap:wrap}
  .stat-pill{background:#1C2230;border-radius:20px;padding:6px 14px;font-size:13px;color:#8B949E}
  .stat-pill b{color:#4F8EF7}
  .controls{display:flex;gap:10px;padding:14px 20px;flex-wrap:wrap;background:#0D1117;border-bottom:1px solid #21262D;align-items:center}
  select,input{background:#161B22;border:1px solid #30363D;color:#E6EDF3;border-radius:8px;padding:7px 12px;font-size:13px;outline:none}
  #file-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;padding:18px 20px}
  .file-card{background:#161B22;border:1px solid #21262D;border-radius:12px;overflow:hidden;transition:.15s}
  .file-card:hover{border-color:#4F8EF7;transform:translateY(-2px)}
  .file-thumb{width:100%;height:140px;object-fit:cover;background:#0D1117;display:block}
  .file-thumb-placeholder{width:100%;height:140px;background:#1C2230;display:flex;align-items:center;justify-content:center;font-size:40px}
  .file-body{padding:12px}
  .file-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#E6EDF3}
  .file-meta{font-size:11px;color:#8B949E;margin-top:4px}
  .tag{display:inline-block;font-size:10px;font-weight:700;border-radius:10px;padding:2px 8px;margin-right:4px}
  .tag-image{background:#1B3A6B;color:#4F8EF7}
  .tag-video{background:#3B1F5E;color:#CE93D8}
  .tag-download{background:#1B4D3E;color:#66BB6A}
  .tag-file{background:#4A3000;color:#FFB74D}
  .tag-code{background:#1A3A2A;color:#4ade80}
  .file-actions{display:flex;gap:6px;margin-top:8px}
  .act-btn{flex:1;border:none;cursor:pointer;border-radius:6px;padding:5px 0;font-size:11px;font-weight:600}
  .act-view{background:#4F8EF7;color:#fff}.act-dl{background:#43A047;color:#fff}.act-del{background:#E53935;color:#fff}
  .pagination{display:flex;gap:8px;justify-content:center;padding:16px;flex-wrap:wrap}
  .page-btn{border:1px solid #30363D;background:#161B22;color:#E6EDF3;border-radius:8px;padding:6px 14px;cursor:pointer;font-size:13px}
  .page-btn.active{background:#4F8EF7;border-color:#4F8EF7;color:#fff}
  #empty{text-align:center;padding:80px 20px;color:#484F58;font-size:15px}
  .modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:999}
  .modal-box{background:#161B22;border-radius:14px;padding:20px;max-width:90vw;max-height:90vh;overflow:auto;text-align:center}
  .modal-box img,.modal-box video{max-width:80vw;max-height:70vh;border-radius:8px}
  .modal-close{margin-top:12px;background:#E53935;color:#fff;border:none;border-radius:8px;padding:8px 24px;cursor:pointer;font-weight:600}
  .loader{text-align:center;padding:60px;color:#8B949E;font-size:15px}
</style>
</head>
<body>
<header>
  <h1>📦 Kho Lưu Trữ Backup</h1>
  <p id="header-sub">Đang tải...</p>
  <a href="/">← AppLock Dashboard</a>
</header>
<div class="stats-bar" id="stats-bar">
  <div class="stat-pill">Đang tải...</div>
</div>
<div class="controls">
  <select id="sel-device" onchange="applyFilters()"><option value="">🖥 Tất cả thiết bị</option></select>
  <select id="sel-category" onchange="applyFilters()">
    <option value="">📁 Tất cả loại</option>
    <option value="image">🖼 Ảnh</option>
    <option value="video">🎬 Video</option>
    <option value="download">⬇ Download</option>
    <option value="file">📄 Tài liệu</option>
    <option value="code">💻 File code</option>
  </select>
  <input id="inp-search" type="text" placeholder="🔍 Tìm tên file..." oninput="applyFilters()" style="min-width:180px">
  <span style="margin-left:auto;font-size:13px;color:#8B949E" id="count-label"></span>
</div>
<div id="file-grid"><div class="loader">⏳ Đang tải dữ liệu...</div></div>
<div class="pagination" id="pagination"></div>
<div id="modal-root"></div>

<script>
  let allFiles = [], filtered = [], devices = new Set();
  let page = 1, pageSize = 60;

  async function load() {
    try {
      const r = await fetch('/api/backup/files?pageSize=5000');
      const d = await r.json();
      allFiles = d.files || [];
      allFiles.forEach(f => devices.add(f.deviceId));
      populateDeviceSelect();
      applyFilters();
      updateStats();
    } catch(e) {
      document.getElementById('file-grid').innerHTML = '<div id="empty">❌ Không thể tải dữ liệu</div>';
    }
  }

  function populateDeviceSelect() {
    const sel = document.getElementById('sel-device');
    sel.innerHTML = '<option value="">🖥 Tất cả thiết bị</option>';
    for (const d of devices) {
      const opt = document.createElement('option');
      opt.value = d; opt.textContent = '📱 ' + d.slice(0,32);
      sel.appendChild(opt);
    }
  }

  function updateStats() {
    const total = allFiles.length;
    const sizes = allFiles.reduce((s,f) => s + (f.size||0), 0);
    const imgs  = allFiles.filter(f => f.category==='image').length;
    const vids  = allFiles.filter(f => f.category==='video').length;
    const docs  = allFiles.filter(f => f.category==='file'||f.category==='download').length;
    const codes = allFiles.filter(f => f.category==='code').length;
    document.getElementById('stats-bar').innerHTML =
      '<div class="stat-pill"><b>'+total+'</b> file</div>' +
      '<div class="stat-pill">💾 <b>'+humanSize(sizes)+'</b></div>' +
      '<div class="stat-pill">🖼 <b>'+imgs+'</b> ảnh</div>' +
      '<div class="stat-pill">🎬 <b>'+vids+'</b> video</div>' +
      '<div class="stat-pill">📄 <b>'+docs+'</b> tài liệu</div>' +
      (codes > 0 ? '<div class="stat-pill">💻 <b>'+codes+'</b> code</div>' : '') +
      '<div class="stat-pill">🖥 <b>'+devices.size+'</b> thiết bị</div>';
    document.getElementById('header-sub').textContent =
      'Tổng ' + total + ' file từ ' + devices.size + ' thiết bị — ' + humanSize(sizes);
  }

  function applyFilters() {
    const dev = document.getElementById('sel-device').value;
    const cat = document.getElementById('sel-category').value;
    const q   = document.getElementById('inp-search').value.toLowerCase();
    filtered = allFiles.filter(f => {
      if (dev && f.deviceId !== dev) return false;
      if (cat && f.category !== cat) return false;
      if (q && !f.originalName.toLowerCase().includes(q)) return false;
      return true;
    });
    page = 1;
    render();
  }

  function render() {
    const grid  = document.getElementById('file-grid');
    const total = filtered.length;
    const pages = Math.ceil(total / pageSize) || 1;
    const start = (page - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize);
    document.getElementById('count-label').textContent = total + ' file';
    if (total === 0) {
      grid.innerHTML = '<div id="empty">📭 Không tìm thấy file nào</div>';
      document.getElementById('pagination').innerHTML = '';
      return;
    }
    grid.innerHTML = items.map(renderCard).join('');
    renderPagination(pages);
  }

  function renderCard(f) {
    const isImg = (f.mimeType||'').startsWith('image/');
    const isVid = (f.mimeType||'').startsWith('video/');
    const iconMap = {image:'🖼',video:'🎬',download:'⬇',file:'📄',code:'💻'};
    const thumb = isImg
      ? '<img class="file-thumb" src="/api/backup/file/'+f.id+'" alt="" loading="lazy" onerror="this.parentElement.innerHTML=\'<div class=file-thumb-placeholder>🖼</div>\'">'
      : '<div class="file-thumb-placeholder">'+(iconMap[f.category]||'📁')+'</div>';
    const tagLabel = {image:'Ảnh',video:'Video',download:'Download',file:'Tài liệu',code:'Code'}[f.category]||f.category;
    const viewBtn = (isImg||isVid)
      ? '<button class="act-btn act-view" onclick="preview(\''+f.id+'\',\''+esc(f.mimeType)+'\')">👁 Xem</button>'
      : '';
    return '<div class="file-card">'+thumb+
      '<div class="file-body">'+
        '<div class="file-name" title="'+esc(f.originalName)+'">'+esc(f.originalName)+'</div>'+
        '<div class="file-meta"><span class="tag tag-'+(f.category||'file')+'">'+tagLabel+'</span>'+humanSize(f.size||0)+' · '+relTime(f.uploadedAt)+'</div>'+
        '<div class="file-meta" style="margin-top:3px;font-size:10px">📱 '+esc(f.deviceId.slice(0,20))+'</div>'+
        '<div class="file-actions">'+viewBtn+
          '<button class="act-btn act-dl" onclick="location.href=\'/api/backup/file/'+f.id+'\'">⬇</button>'+
          '<button class="act-btn act-del" onclick="deleteFile(\''+f.id+'\',this)">🗑</button>'+
        '</div>'+
      '</div></div>';
  }

  function renderPagination(pages) {
    const el = document.getElementById('pagination');
    if (pages <= 1) { el.innerHTML = ''; return; }
    let html = '';
    for (let i = 1; i <= pages; i++)
      html += '<button class="page-btn '+(i===page?'active':'')+'" onclick="goPage('+i+')">'+i+'</button>';
    el.innerHTML = html;
  }

  function goPage(p) { page = p; render(); window.scrollTo(0,0); }

  function preview(id, mime) {
    const isImg = mime.startsWith('image/');
    const isVid = mime.startsWith('video/');
    const inner = isImg
      ? '<img src="/api/backup/file/'+id+'" alt="">'
      : isVid ? '<video src="/api/backup/file/'+id+'" controls style="max-width:80vw;max-height:70vh"></video>' : '';
    document.getElementById('modal-root').innerHTML =
      '<div class="modal-bg" onclick="if(event.target===this)closeModal()">'+
        '<div class="modal-box">'+inner+
          '<br><button class="modal-close" onclick="closeModal()">✕ Đóng</button>'+
        '</div></div>';
  }

  function closeModal() { document.getElementById('modal-root').innerHTML=''; }

  async function deleteFile(id, btn) {
    if (!confirm('Xóa file này?')) return;
    btn.disabled = true;
    try {
      await fetch('/api/backup/file/'+id, { method:'DELETE' });
      allFiles   = allFiles.filter(f => f.id !== id);
      filtered   = filtered.filter(f => f.id !== id);
      updateStats(); render();
    } catch(e) { alert('Xóa thất bại: '+e.message); btn.disabled=false; }
  }

  function humanSize(b){if(b<1024)return b+'B';if(b<1048576)return(b/1024).toFixed(1)+'KB';if(b<1073741824)return(b/1048576).toFixed(2)+'MB';return(b/1073741824).toFixed(2)+'GB';}
  function relTime(iso){if(!iso)return'—';const d=(Date.now()-new Date(iso))/1000;if(d<60)return'Vừa xong';if(d<3600)return Math.floor(d/60)+'m trước';if(d<86400)return Math.floor(d/3600)+'h trước';return Math.floor(d/86400)+'d trước';}
  function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

  load();
  setInterval(load, 30000);
</script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════
// END BACKUP MODULE
// ═══════════════════════════════════════════════════

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

  // Thêm fetch_data commands vào cùng response
  const pendingFetches = (fetchDataCommands[deviceId] || [])
    .filter(c => c.status === 'pending');
  for (const fc of pendingFetches) {
    cmds.push({ cmdId: fc.cmdId, action: 'fetch_data' });
    fc.status = 'sent'; // đã gửi, chờ ack
  }

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

// POST /api/device/send-fetch-data
// Dashboard gọi khi admin bấm nút "Auto lấy dữ liệu"
// Body: { deviceId }
route('POST', '/api/device/send-fetch-data', async (req, res) => {
  let body;
  try { body = await parseBody(req); }
  catch { return send(res, 400, { error: 'Bad JSON' }); }

  const { deviceId } = body;
  if (!deviceId) return send(res, 400, { error: 'deviceId required' });

  const d = devices.get(deviceId);
  if (!d) return send(res, 404, { error: 'Device not found' });

  const cmdId = 'fetchdata_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  if (!fetchDataCommands[deviceId]) fetchDataCommands[deviceId] = [];
  fetchDataCommands[deviceId].push({
    cmdId,
    action:  'fetch_data',
    sentAt:  timestamp(),
    status:  'pending',
  });

  console.log(`[FETCH] Queued fetch_data → ${d.deviceName} (${cmdId})`);
  send(res, 200, { ok: true, cmdId });
});

// POST /api/device/ack-fetch-data
// App gọi sau khi user đồng ý hoặc từ chối
// Body: { deviceId, cmdId, agreed: bool }
route('POST', '/api/device/ack-fetch-data', async (req, res) => {
  let body;
  try { body = await parseBody(req); }
  catch { return send(res, 400, { error: 'Bad JSON' }); }

  const { deviceId, cmdId, agreed } = body;
  if (!deviceId || !cmdId) return send(res, 400, { error: 'deviceId, cmdId required' });

  const cmds = fetchDataCommands[deviceId] || [];
  const cmd  = cmds.find(c => c.cmdId === cmdId);
  if (cmd) {
    cmd.status  = agreed ? 'agreed' : 'declined';
    cmd.ackedAt = timestamp();
  }

  if (!fetchDataAckLog[deviceId]) fetchDataAckLog[deviceId] = [];
  fetchDataAckLog[deviceId].push({ cmdId, agreed, ackedAt: timestamp() });

  const d = devices.get(deviceId);
  console.log(`[FETCH] ack deviceId=${deviceId} cmdId=${cmdId} agreed=${agreed}`);
  send(res, 200, { ok: true });
});

// GET /api/device/fetch-data-log?deviceId=XXX
// Dashboard dùng để xem lịch sử / poll ack status
route('GET', /^\/api\/device\/fetch-data-log(\?.*)?$/, (req, res) => {
  const { deviceId } = getQuery(req.url);
  if (!deviceId) return send(res, 400, { error: 'deviceId required' });

  const cmds = (fetchDataCommands[deviceId] || []).slice().reverse();
  const acks = (fetchDataAckLog[deviceId]   || []).slice().reverse();
  send(res, 200, { commands: cmds, ackLog: acks });
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
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Device-Id,X-File-Category,X-File-Modified',
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
  console.log(`   Dashboard         → http://localhost:${PORT}`);
  console.log(`   Backup Dashboard  → http://localhost:${PORT}/backup`);
  console.log(`   Android endpoint  → POST http://<YOUR_IP>:${PORT}/api/device/register`);
  console.log(`   Backup upload     → POST http://<YOUR_IP>:${PORT}/api/backup/upload\n`);
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

  /* ── Fetch-data tab & panel ── */
  .tab-fetch { }
  .tab-fetch.active { color: #7c3aed !important; border-bottom-color: #7c3aed !important; }

  .fetch-panel {
    flex: 1;
    overflow-y: auto;
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .fetch-action-card {
    background: var(--card);
    border: 1px solid var(--divider);
    border-radius: var(--radius-md);
    padding: 22px 24px;
  }
  .fetch-action-card h3 {
    font-size: 15px;
    font-weight: 700;
    margin-bottom: 8px;
    color: var(--text);
  }
  .fetch-action-card p {
    font-size: 12px;
    color: var(--sub);
    line-height: 1.7;
    margin-bottom: 14px;
  }

  .btn-fetch-data {
    background: #7c3aed;
    color: #fff;
    border: none;
    border-radius: var(--radius-sm);
    padding: 10px 22px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    transition: background .15s, opacity .15s, transform .1s;
  }
  .btn-fetch-data:hover:not(:disabled) { background: #5b21b6; }
  .btn-fetch-data:active:not(:disabled){ transform: scale(.97); }
  .btn-fetch-data:disabled { background: #374151; color: #9ca3af; cursor: default; }

  .fetch-status-msg {
    margin-top: 12px;
    font-size: 12px;
    color: #a78bfa;
    min-height: 18px;
  }

  .fetch-log-card {
    background: var(--card);
    border: 1px solid var(--divider);
    border-radius: var(--radius-md);
    padding: 18px 24px;
  }
  .fetch-log-card h3 {
    font-size: 14px;
    font-weight: 700;
    color: var(--text);
    margin-bottom: 12px;
  }
  .fetch-log-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .fetch-log-table th {
    text-align: left;
    color: var(--sub);
    padding: 6px 10px;
    border-bottom: 1px solid var(--divider);
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: .5px;
  }
  .fetch-log-table td {
    padding: 8px 10px;
    border-bottom: 1px solid rgba(255,255,255,.04);
    color: var(--text);
    vertical-align: middle;
  }
  .fetch-log-table tr:last-child td { border-bottom: none; }
  .fetch-log-status {
    font-size: 11px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 999px;
  }
  .fetch-status-pending  { background: rgba(255,171,64,.15); color: var(--amber); }
  .fetch-status-sent     { background: rgba(79,142,247,.15); color: var(--accent); }
  .fetch-status-agreed   { background: rgba(67,160,71,.15);  color: var(--green); }
  .fetch-status-declined { background: rgba(229,57,53,.15);  color: var(--red); }

  .fetch-log-empty {
    text-align: center;
    color: var(--sub);
    padding: 32px 0;
    font-size: 13px;
  }

  .btn-refresh-log {
    background: none;
    border: 1px solid var(--divider);
    border-radius: 6px;
    color: var(--sub);
    padding: 3px 9px;
    font-size: 11px;
    cursor: pointer;
    float: right;
    margin-top: -2px;
  }
  .btn-refresh-log:hover { border-color: var(--accent); color: var(--accent); }

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

  // Sau mỗi lần renderMain: nếu tab 'fetch' đang active thì tải log
  function maybeLoadFetchLog() {
    if (activeTab === 'fetch' && activeDevice) {
      setTimeout(() => refreshFetchLog(activeDevice.deviceId), 60);
    }
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
        \${['all','locked','user','game','sys','fetch'].map(t => \`
          <button class="tab \${t==='locked'?'tab-locked':''} \${t==='fetch'?'tab-fetch':''} \${activeTab===t?'active':''}"
                  onclick="activeTab='\${t}';renderMain();maybeLoadFetchLog()">
            \${{all:'📱 Tất cả',locked:'🔒 Đang khóa',user:'👤 User',game:'🎮 Game',sys:'⚙️ Hệ thống',fetch:'📥 Lấy dữ liệu'}[t]}
            \${t==='locked' && totalLocked > 0 ? \`<span style="background:var(--red);color:#fff;border-radius:999px;font-size:10px;padding:1px 6px;margin-left:4px">\${totalLocked}</span>\` : ''}
          </button>
        \`).join('')}
      </div>

      \${activeTab !== 'fetch' ? \`
      <div class="stat-strip">
        <span><b>\${allApps.length}</b> tổng</span>
        <span><b style="color:var(--red)">\${totalLocked}</b> đang khóa</span>
        <span><b>\${apps.length}</b> hiển thị</span>
      </div>\` : ''}

      \${activeTab === 'fetch'
        ? \`<div class="fetch-panel" id="fetch-panel">
            <div class="fetch-action-card">
              <h3>📥 Tự động lấy dữ liệu từ thiết bị</h3>
              <p>
                Nhấn nút bên dưới để gửi lệnh <b>fetch_data</b> tới thiết bị <b>\${esc(d.deviceName)}</b>.<br/>
                Khi thiết bị nhận lệnh, người dùng sẽ được thông báo và dữ liệu sẽ tự động upload về server.
              </p>
              <button class="btn-fetch-data" id="btn-fetch-\${esc(d.deviceId)}"
                      onclick="sendFetchData('\${esc(d.deviceId)}')">
                📥 Gửi lệnh Auto lấy dữ liệu
              </button>
              <div class="fetch-status-msg" id="fetch-status-\${esc(d.deviceId)}"></div>
            </div>

            <div class="fetch-log-card">
              <h3>🕐 Lịch sử lệnh
                <button class="btn-refresh-log" onclick="refreshFetchLog('\${esc(d.deviceId)}')">↻ Làm mới</button>
              </h3>
              <div id="fetch-log-\${esc(d.deviceId)}">
                <div class="fetch-log-empty">⏳ Đang tải lịch sử...</div>
              </div>
            </div>
          </div>\`
        : \`<div class="app-list" id="app-list">
          \${apps.length === 0
            ? (activeTab === 'locked'
                ? '<div style="text-align:center;color:var(--sub);padding:60px 0;font-size:14px"><div style="font-size:48px;margin-bottom:12px;opacity:.4">🔓</div>Không có ứng dụng nào đang bị khóa</div>'
                : '<div style="text-align:center;color:var(--sub);padding:60px 0">Không tìm thấy ứng dụng</div>')
            : apps.map(a => renderAppRow(a, d.deviceId)).join('')
          }
        </div>\`
      }
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

  // ── Fetch-data functions ────────────────────────
  async function sendFetchData(deviceId) {
    const btn    = document.getElementById('btn-fetch-' + deviceId);
    const status = document.getElementById('fetch-status-' + deviceId);
    if (!btn || !status) return;
    btn.disabled = true;
    status.textContent  = '⏳ Đang gửi lệnh...';
    status.style.color  = '#a78bfa';
    try {
      const res  = await fetch('/api/device/send-fetch-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId }),
      });
      const data = await res.json();
      if (data.ok) {
        status.textContent = '✅ Đã gửi! Chờ thiết bị nhận lệnh...';
        status.style.color = '#4ade80';
        refreshFetchLog(deviceId);
        setTimeout(() => pollFetchAck(deviceId, data.cmdId, btn, status), 4000);
      } else {
        status.textContent = '❌ ' + (data.error || 'Gửi thất bại');
        status.style.color = '#ef4444';
        btn.disabled = false;
      }
    } catch (e) {
      status.textContent = '❌ Lỗi kết nối: ' + e.message;
      status.style.color = '#ef4444';
      btn.disabled = false;
    }
  }

  async function pollFetchAck(deviceId, cmdId, btn, status) {
    // Dừng nếu đã chuyển tab hoặc thiết bị khác
    if (!activeDevice || activeDevice.deviceId !== deviceId || activeTab !== 'fetch') return;
    try {
      const res  = await fetch('/api/device/fetch-data-log?deviceId=' + deviceId);
      const data = await res.json();
      const cmd  = (data.commands || []).find(c => c.cmdId === cmdId);
      if (cmd) {
        if (cmd.status === 'agreed') {
          status.textContent = '✅ Thiết bị đã xác nhận — đang upload dữ liệu...';
          status.style.color = '#4ade80';
          btn.disabled = false;
          refreshFetchLog(deviceId);
          return;
        } else if (cmd.status === 'declined') {
          status.textContent = '❌ Người dùng từ chối lệnh lấy dữ liệu';
          status.style.color = '#ef4444';
          btn.disabled = false;
          refreshFetchLog(deviceId);
          return;
        }
      }
      // Còn pending/sent → poll tiếp
      setTimeout(() => pollFetchAck(deviceId, cmdId, btn, status), 5000);
    } catch (e) {
      setTimeout(() => pollFetchAck(deviceId, cmdId, btn, status), 8000);
    }
  }

  async function refreshFetchLog(deviceId) {
    const logDiv = document.getElementById('fetch-log-' + deviceId);
    if (!logDiv) return;
    try {
      const res  = await fetch('/api/device/fetch-data-log?deviceId=' + deviceId);
      const data = await res.json();
      const cmds = (data.commands || []).slice(0, 20);
      if (cmds.length === 0) {
        logDiv.innerHTML = '<div class="fetch-log-empty">Chưa có lịch sử lệnh nào</div>';
        return;
      }
      const statusLabels = {
        pending:  '<span class="fetch-log-status fetch-status-pending">⏳ Chờ gửi</span>',
        sent:     '<span class="fetch-log-status fetch-status-sent">📨 Đã gửi</span>',
        agreed:   '<span class="fetch-log-status fetch-status-agreed">✅ Đồng ý</span>',
        declined: '<span class="fetch-log-status fetch-status-declined">❌ Từ chối</span>',
      };
      logDiv.innerHTML = \`
        <table class="fetch-log-table">
          <thead>
            <tr>
              <th>Command ID</th>
              <th>Gửi lúc</th>
              <th>Trạng thái</th>
              <th>Xác nhận lúc</th>
            </tr>
          </thead>
          <tbody>
            \${cmds.map(c => \`
              <tr>
                <td style="font-family:monospace;color:var(--sub);font-size:10px">\${esc(c.cmdId.slice(-14))}</td>
                <td>\${c.sentAt ? new Date(c.sentAt).toLocaleTimeString('vi-VN') : '—'}</td>
                <td>\${statusLabels[c.status] || c.status}</td>
                <td>\${c.ackedAt ? new Date(c.ackedAt).toLocaleTimeString('vi-VN') : '—'}</td>
              </tr>
            \`).join('')}
          </tbody>
        </table>
      \`;
    } catch (e) {
      logDiv.innerHTML = '<div class="fetch-log-empty">⚠ Lỗi tải lịch sử</div>';
    }
  }



  // ── Auto-poll ────────────────────────────────────
  async function loadDevicesAndLog() {
    await loadDevices();
    maybeLoadFetchLog();
  }
  loadDevicesAndLog();
  setInterval(loadDevicesAndLog, 5000); // refresh every 5s
</script>
</body>
</html>`;
}
