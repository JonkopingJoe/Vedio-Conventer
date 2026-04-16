'use strict';

/**
 * In-memory job store.
 * Each job holds all state for one conversion request.
 *
 * Job shape:
 * {
 *   jobId:        string   (UUID v4)
 *   status:       'queued' | 'converting' | 'done' | 'failed'
 *   percent:      number   (0–100)
 *   filename:     string   (original upload filename)
 *   sizeBytes:    number
 *   inputPath:    string
 *   outputPath:   string
 *   targetFormat: string   (output format key, e.g. 'mp4', 'avi')
 *   createdAt:    number   (Date.now())
 *   sseClients:   Response[] (active SSE connections)
 *   error:        string | null
 * }
 */

const jobs = new Map();

function createJob({ jobId, filename, sizeBytes, inputPath, outputPath, targetFormat }) {
  const job = {
    jobId,
    status: 'queued',
    percent: 0,
    filename,
    sizeBytes,
    inputPath,
    outputPath,
    targetFormat: targetFormat || 'avi',
    createdAt: Date.now(),
    sseClients: [],
    error: null,
  };
  jobs.set(jobId, job);
  return job;
}

function getJob(jobId) {
  return jobs.get(jobId) || null;
}

function updateJob(jobId, changes) {
  const job = jobs.get(jobId);
  if (!job) return null;
  Object.assign(job, changes);
  broadcastSSE(job);
  return job;
}

function deleteJob(jobId) {
  jobs.delete(jobId);
}

function getAllJobs() {
  return Array.from(jobs.values());
}

/**
 * Push an SSE event to all connected clients for this job.
 * Called automatically by updateJob whenever job state changes.
 */
function broadcastSSE(job) {
  if (!job.sseClients.length) return;

  let eventName;
  let data;

  if (job.status === 'queued') {
    eventName = 'queued';
    data = { position: getQueuePosition(job.jobId) };
  } else if (job.status === 'converting') {
    eventName = 'progress';
    data = { percent: job.percent };
  } else if (job.status === 'done') {
    eventName = 'done';
    data = { jobId: job.jobId };
  } else if (job.status === 'failed') {
    eventName = 'error';
    data = { message: job.error || 'Conversion failed.' };
  } else {
    return;
  }

  const message = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;

  for (const client of job.sseClients) {
    try {
      client.write(message);
      if (job.status === 'done' || job.status === 'failed') {
        client.end();
      }
    } catch (_) {
      // client disconnected; will be pruned on 'close' event
    }
  }
}

/** Count how many jobs are currently 'queued' ahead of this one. */
function getQueuePosition(jobId) {
  let position = 0;
  for (const [id, job] of jobs) {
    if (id === jobId) break;
    if (job.status === 'queued') position++;
  }
  return position;
}

module.exports = { createJob, getJob, updateJob, deleteJob, getAllJobs };
