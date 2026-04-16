'use strict';

const router = require('express').Router();
const { getJob } = require('../services/jobStore');

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

  // ── SSE headers ──────────────────────────────────────────────────────────
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering for SSE
  res.flushHeaders();

  function send(eventName, data) {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // ── Terminal states: reply immediately and close ──────────────────────────
  if (job.status === 'done') {
    send('done', { jobId });
    return res.end();
  }
  if (job.status === 'failed') {
    send('error', { message: job.error || 'Conversion failed.' });
    return res.end();
  }

  // ── Send current snapshot so the client isn't left wondering ─────────────
  if (job.status === 'queued') {
    send('queued', { position: job.queuePosition || 0 });
  } else if (job.status === 'converting') {
    send('progress', { percent: job.percent });
  }

  // ── Register client and remove on disconnect ──────────────────────────────
  job.sseClients.push(res);

  req.on('close', () => {
    const idx = job.sseClients.indexOf(res);
    if (idx !== -1) job.sseClients.splice(idx, 1);
  });
});

module.exports = router;
