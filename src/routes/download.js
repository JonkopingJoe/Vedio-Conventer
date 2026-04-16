'use strict';

const router = require('express').Router();
const fs     = require('fs');

const { FORMATS }  = require('../config/formats');
const { getJob }   = require('../services/jobStore');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

router.get('/:jobId', (req, res) => {
  const { jobId } = req.params;

  if (!UUID_RE.test(jobId)) {
    return res.status(400).json({ error: 'Invalid job ID.' });
  }

  const job = getJob(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found or has expired.' });
  }
  if (job.status !== 'done') {
    return res.status(409).json({ error: 'Conversion is not complete yet.' });
  }
  if (!fs.existsSync(job.outputPath)) {
    return res.status(410).json({ error: 'File has expired. Please convert again.' });
  }

  const fmt      = FORMATS[job.targetFormat] || FORMATS['avi'];
  const stat     = fs.statSync(job.outputPath);
  const filename = `converted${fmt.ext}`;

  res.setHeader('Content-Type',        fmt.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length',      stat.size);

  const stream = fs.createReadStream(job.outputPath);
  stream.pipe(res);

  stream.on('error', (err) => {
    console.error(`[download] Stream error for job ${jobId}:`, err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to send the file.' });
    }
  });
});

module.exports = router;
