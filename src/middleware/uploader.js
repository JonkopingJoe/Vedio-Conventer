'use strict';

const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const { randomUUID } = require('crypto');

const { ALLOWED_INPUT_EXTENSIONS } = require('../config/formats');

const TMP_DIR     = path.join(__dirname, '../../tmp');
const MAX_FILE_MB = () => parseInt(process.env.MAX_FILE_MB || '500', 10);
const MAX_BYTES   = () => MAX_FILE_MB() * 1024 * 1024;

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const jobId  = randomUUID();
    const jobDir = path.join(TMP_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    req.jobId  = jobId;
    req.jobDir = jobDir;

    cb(null, jobDir);
  },
  filename(_req, file, cb) {
    // Preserve the original extension so FFmpeg can probe the container.
    const ext = path.extname(file.originalname).toLowerCase() || '.bin';
    cb(null, `input${ext}`);
  },
});

function fileFilter(_req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_INPUT_EXTENSIONS.has(ext)) {
    const err  = new Error(`Unsupported file type "${ext || '(none)'}". Accepted: MP4, AVI, MKV, MOV, WebM, FLV.`);
    err.code   = 'INVALID_EXTENSION';
    return cb(err, false);
  }
  cb(null, true);
}

const uploadSingle = multer({
  storage,
  limits: { fileSize: MAX_BYTES() },
  fileFilter,
}).single('file');

/**
 * Confirm the file has a recognisable video container signature.
 * This is a security gate against renamed non-video files.
 * FFmpeg's own probe handles the rest.
 *
 * Signatures checked:
 *   MP4 / MOV  — 'ftyp' box at byte offset 4
 *   MKV / WebM — EBML header  0x1A 0x45 0xDF 0xA3  at offset 0
 *   AVI        — 'RIFF'                              at offset 0
 *   FLV        — 'FLV\x01'                           at offset 0
 *   WMV / ASF  — 0x30 0x26 0xB2 0x75                at offset 0
 */
async function assertVideoMagicBytes(filePath) {
  const fd     = await fs.promises.open(filePath, 'r');
  const buffer = Buffer.alloc(12);
  try {
    const { bytesRead } = await fd.read(buffer, 0, 12, 0);
    if (bytesRead < 4) return false;

    // MP4 / MOV
    if (bytesRead >= 8 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') return true;
    // MKV / WebM (EBML)
    if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) return true;
    // AVI (RIFF container)
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF') return true;
    // FLV
    if (buffer[0] === 0x46 && buffer[1] === 0x4C && buffer[2] === 0x56) return true;
    // WMV / ASF
    if (buffer[0] === 0x30 && buffer[1] === 0x26 && buffer[2] === 0xB2 && buffer[3] === 0x75) return true;

    return false;
  } finally {
    await fd.close();
  }
}

function removeJobDir(dirPath) {
  try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch (_) {}
}

module.exports = { uploadSingle, assertVideoMagicBytes, removeJobDir };
