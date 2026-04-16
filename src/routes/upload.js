'use strict';

const router = require('express').Router();
const path   = require('path');

const { uploadSingle, assertVideoMagicBytes, removeJobDir } = require('../middleware/uploader');
const { FORMATS } = require('../config/formats');
const { createJob }       = require('../services/jobStore');
const { startConversion } = require('../services/converter');

router.post('/', (req, res) => {
  uploadSingle(req, res, async (err) => {
    // ── Multer errors ────────────────────────────────────────────────────────
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const maxMB = process.env.MAX_FILE_MB || 500;
        return res.status(413).json({ error: `File too large. Maximum size is ${maxMB} MB.` });
      }
      if (err.code === 'INVALID_EXTENSION') {
        return res.status(400).json({ error: err.message });
      }
      console.error('[upload] Multer error:', err.message);
      return res.status(500).json({ error: 'Upload failed. Please try again.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file received. Send a file in the "file" field.' });
    }

    // ── Resolve and validate target format ───────────────────────────────────
    const targetFormat = (req.body && req.body.targetFormat) || 'avi';

    if (!FORMATS[targetFormat]) {
      removeJobDir(req.jobDir);
      return res.status(400).json({ error: `Unsupported output format "${targetFormat}".` });
    }

    const filePath   = req.file.path;
    const fileSize   = req.file.size;
    const origName   = req.file.originalname;
    const { jobId, jobDir } = req;
    const outputExt  = FORMATS[targetFormat].ext;
    const outputPath = path.join(jobDir, `output${outputExt}`);

    // ── Magic byte check ─────────────────────────────────────────────────────
    let valid = false;
    try {
      valid = await assertVideoMagicBytes(filePath);
    } catch (_) {
      valid = false;
    }

    if (!valid) {
      removeJobDir(jobDir);
      return res.status(400).json({ error: 'The uploaded file does not appear to be a valid video file.' });
    }

    // ── Create job and start conversion ──────────────────────────────────────
    createJob({
      jobId,
      filename: origName,
      sizeBytes: fileSize,
      inputPath: filePath,
      outputPath,
      targetFormat,
    });

    startConversion(jobId).catch((e) => {
      console.error(`[upload] Unhandled converter error for job ${jobId}:`, e.message);
    });

    return res.status(202).json({ jobId, filename: origName, sizeBytes: fileSize, targetFormat });
  });
});

module.exports = router;
