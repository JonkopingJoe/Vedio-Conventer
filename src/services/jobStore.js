'use strict';

const db = require('./db');

// SSE client connections — never persisted, runtime-only
// Map<jobId, Response[]>
const sseClients = new Map();

// ─── Prepared statements ──────────────────────────────────────────────────────

const stmtInsert = db.prepare(`
  INSERT INTO jobs (jobId, status, percent, filename, sizeBytes, inputPath, outputPath, targetFormat, createdAt, error)
  VALUES (@jobId, 'queued', 0, @filename, @sizeBytes, @inputPath, @outputPath, @targetFormat, @createdAt, NULL)
`);

const stmtSelect = db.prepare('SELECT * FROM jobs WHERE jobId = ?');

const stmtSelectAll = db.prepare('SELECT * FROM jobs');

const stmtDelete = db.prepare('DELETE FROM jobs WHERE jobId = ?');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rowToJob(row) {
  if (!row) return null;
  return { ...row, sseClients: sseClients.get(row.jobId) || [] };
}

// ─── Public API ───────────────────────────────────────────────────────────────

function createJob({ jobId, filename, sizeBytes, inputPath, outputPath, targetFormat }) {
  stmtInsert.run({
    jobId,
    filename,
    sizeBytes,
    inputPath,
    outputPath,
    targetFormat: targetFormat || 'avi',
    createdAt:    Date.now(),
  });
  sseClients.set(jobId, []);
  return getJob(jobId);
}

function getJob(jobId) {
  return rowToJob(stmtSelect.get(jobId));
}

function updateJob(jobId, changes) {
  const allowed = ['status', 'percent', 'error'];
  const fields  = Object.keys(changes).filter((k) => allowed.includes(k));
  if (!fields.length) return getJob(jobId);

  const setClauses = fields.map((k) => `${k} = @${k}`).join(', ');
  const values     = {};
  fields.forEach((k) => { values[k] = changes[k]; });
  values.jobId = jobId;

  db.prepare(`UPDATE jobs SET ${setClauses} WHERE jobId = @jobId`).run(values);

  const job = getJob(jobId);
  if (job) broadcastSSE(job);
  return job;
}

function deleteJob(jobId) {
  stmtDelete.run(jobId);
  sseClients.delete(jobId);
}

function getAllJobs() {
  return stmtSelectAll.all().map(rowToJob);
}

// ─── SSE broadcast ────────────────────────────────────────────────────────────

function broadcastSSE(job) {
  const clients = sseClients.get(job.jobId) || [];
  if (!clients.length) return;

  let eventName, data;

  if (job.status === 'queued') {
    eventName = 'queued';
    data      = { position: getQueuePosition(job.jobId) };
  } else if (job.status === 'converting') {
    eventName = 'progress';
    data      = { percent: job.percent };
  } else if (job.status === 'done') {
    eventName = 'done';
    data      = { jobId: job.jobId };
  } else if (job.status === 'failed') {
    eventName = 'error';
    data      = { message: job.error || 'Conversion failed.' };
  } else {
    return;
  }

  const message = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;

  for (const client of clients) {
    try {
      client.write(message);
      if (job.status === 'done' || job.status === 'failed') client.end();
    } catch (_) {
      // client disconnected; pruned on 'close' event in progress route
    }
  }
}

function getQueuePosition(jobId) {
  const queued = db.prepare("SELECT jobId FROM jobs WHERE status = 'queued'").all();
  let position = 0;
  for (const row of queued) {
    if (row.jobId === jobId) break;
    position++;
  }
  return position;
}

// ─── Startup recovery ─────────────────────────────────────────────────────────

function recoverStalledJobs() {
  const result = db.prepare(`
    UPDATE jobs SET status = 'failed', error = 'Server restarted during conversion.'
    WHERE status IN ('queued', 'converting')
  `).run();
  if (result.changes > 0) {
    console.log(`[jobStore] Marked ${result.changes} stalled job(s) as failed on startup`);
  }
}

module.exports = { createJob, getJob, updateJob, deleteJob, getAllJobs, recoverStalledJobs };
