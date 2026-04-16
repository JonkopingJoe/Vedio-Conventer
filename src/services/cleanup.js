'use strict';

const cron = require('node-cron');
const fs   = require('fs');
const path = require('path');

const { getAllJobs, deleteJob } = require('./jobStore');

const TMP_DIR    = path.join(__dirname, '../../tmp');
const JOB_TTL_MS = () => parseInt(process.env.JOB_TTL_MINUTES || '60', 10) * 60 * 1000;

/**
 * Delete all jobs (and their tmp directories) that are older than JOB_TTL.
 * Also removes any orphaned tmp subdirectories not tracked by the job store
 * (e.g. from uploads that failed before a job was created).
 */
function runCleanup() {
  const now     = Date.now();
  const ttl     = JOB_TTL_MS();
  const jobs    = getAllJobs();
  const tracked = new Set();

  for (const job of jobs) {
    tracked.add(job.jobId);
    if (now - job.createdAt < ttl) continue;

    const dir = path.join(TMP_DIR, job.jobId);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) { /* already gone */ }

    deleteJob(job.jobId);
    console.log(`[cleanup] Removed job ${job.jobId}`);
  }

  // Sweep for orphaned directories (uploads that crashed before createJob ran)
  try {
    const entries = fs.readdirSync(TMP_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.gitkeep') continue;
      if (tracked.has(entry.name)) continue;

      const dir  = path.join(TMP_DIR, entry.name);
      const stat = fs.statSync(dir);
      if (now - stat.mtimeMs > ttl) {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`[cleanup] Removed orphaned dir ${entry.name}`);
      }
    }
  } catch (_) {}
}

function startCleanup() {
  const intervalMin   = parseInt(process.env.CLEANUP_INTERVAL_MINUTES || '30', 10);
  const cronExpr      = `*/${intervalMin} * * * *`;

  // Run once immediately on startup to clear stale files from a previous run
  runCleanup();

  cron.schedule(cronExpr, runCleanup);
  console.log(`[cleanup] Scheduled every ${intervalMin} min`);
}

module.exports = { startCleanup };
