const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { loadConfig } = require('./config');

const TEMP_DIR = path.join(__dirname, '../../temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// fileId -> { id, originalName, mimeType, size, uploadedBy, channelId, path, expiresAt }
const fileRegistry = new Map();

// ── Cleanup expired files every 5 minutes ──
setInterval(() => {
  const now = Date.now();
  for (const [id, meta] of fileRegistry) {
    if (now > meta.expiresAt) {
      try { fs.unlinkSync(meta.path); } catch (_) {}
      fileRegistry.delete(id);
      console.log(`🗑️  Expired file deleted: ${meta.originalName}`);
    }
  }
}, 5 * 60 * 1000);

function registerFile({ originalName, mimeType, size, uploadedBy, channelId, buffer }) {
  const cfg = loadConfig();
  const maxBytes = cfg.media.maxFileSizeMB * 1024 * 1024;
  if (size > maxBytes) return { ok: false, error: `File too large. Max size is ${cfg.media.maxFileSizeMB}MB` };

  const id = crypto.randomBytes(16).toString('hex');
  const ext = path.extname(originalName) || '';
  const filePath = path.join(TEMP_DIR, `${id}${ext}`);

  try {
    fs.writeFileSync(filePath, buffer);
  } catch (err) {
    return { ok: false, error: 'Failed to save file' };
  }

  const expiresAt = Date.now() + cfg.media.tempFileExpiryMinutes * 60 * 1000;
  const meta = { id, originalName, mimeType, size, uploadedBy, channelId, path: filePath, expiresAt };
  fileRegistry.set(id, meta);

  return { ok: true, file: { id, originalName, mimeType, size, uploadedBy, channelId, expiresAt } };
}

function getFileMeta(fileId) {
  return fileRegistry.get(fileId) || null;
}

function getFilePath(fileId) {
  const meta = fileRegistry.get(fileId);
  if (!meta) return null;
  if (Date.now() > meta.expiresAt) {
    try { fs.unlinkSync(meta.path); } catch (_) {}
    fileRegistry.delete(fileId);
    return null;
  }
  return meta.path;
}

function setupFileRoutes(app) {
  const multer = require('multer');
  const cfg = loadConfig();

  const storage = multer.memoryStorage();
  const upload = multer({
    storage,
    limits: { fileSize: cfg.media.maxFileSizeMB * 1024 * 1024 }
  });

  // Upload endpoint
  app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const result = registerFile({
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      uploadedBy: req.body.username || 'unknown',
      channelId: req.body.channelId || 'general',
      buffer: req.file.buffer
    });

    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(result.file);
  });

  // Download endpoint with range request support (needed for video streaming)
  app.get('/api/files/:fileId', (req, res) => {
    const meta = getFileMeta(req.params.fileId);
    if (!meta) return res.status(404).json({ error: 'File not found or expired' });

    const filePath = getFilePath(req.params.fileId);
    if (!filePath) return res.status(404).json({ error: 'File expired' });

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      // Support range requests for video seeking
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': meta.mimeType,
        'Content-Disposition': `inline; filename="${meta.originalName}"`,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': meta.mimeType,
        'Content-Disposition': `attachment; filename="${meta.originalName}"`,
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });

  // File info endpoint
  app.get('/api/files/:fileId/info', (req, res) => {
    const meta = getFileMeta(req.params.fileId);
    if (!meta) return res.status(404).json({ error: 'File not found' });
    const { path: _, ...safe } = meta; // don't expose disk path
    res.json(safe);
  });
}

module.exports = { registerFile, getFileMeta, getFilePath, setupFileRoutes };