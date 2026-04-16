'use strict';

const ffmpeg = require('fluent-ffmpeg');

const { FORMATS }              = require('../config/formats');
const { getJob, updateJob }    = require('./jobStore');
const { acquire, release }     = require('./semaphore');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timemarkToSeconds(timemark) {
  if (!timemark || typeof timemark !== 'string') return 0;
  const parts = timemark.split(':');
  if (parts.length !== 3) return 0;
  return parseInt(parts[0], 10) * 3600
       + parseInt(parts[1], 10) * 60
       + parseFloat(parts[2]);
}

function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const duration = metadata?.format?.duration;
      resolve(typeof duration === 'number' ? duration : 0);
    });
  });
}

function sanitizeError(message) {
  if (!message) return 'Conversion failed.';
  if (/invalid data found/i.test(message))
    return 'The file appears to be corrupted or is not a valid video file.';
  if (/no such file/i.test(message))
    return 'Input file could not be read.';
  if (/encoder.*not found|codec.*not found/i.test(message))
    return 'Required video codec is unavailable on this server.';
  if (/moov atom not found/i.test(message))
    return 'The video file is missing required metadata. Please try a different file.';
  if (/invalid option|option .* not found/i.test(message))
    return 'Conversion settings are not compatible with this file. Please try a different format.';
  return 'Conversion failed. Please try a different file.';
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function startConversion(jobId) {
  updateJob(jobId, { status: 'queued', percent: 0 });
  await acquire();

  const job = getJob(jobId);
  if (!job) { release(); return; }

  // Look up output format config; fall back to AVI if somehow missing
  const config = FORMATS[job.targetFormat] || FORMATS['avi'];

  updateJob(jobId, { status: 'converting', percent: 0 });

  let totalDuration = 0;
  try {
    totalDuration = await probeDuration(job.inputPath);
  } catch (_) {}

  return new Promise((resolve) => {
    let lastPercent = -1;

    ffmpeg(job.inputPath)
      .outputFormat(config.outputFormat)
      .videoCodec(config.videoCodec)
      .audioCodec(config.audioCodec)
      .outputOptions(config.outputOptions)
      .on('progress', (progress) => {
        let percent = 0;

        if (typeof progress.percent === 'number' && !isNaN(progress.percent)) {
          percent = Math.min(99, Math.round(progress.percent));
        } else if (totalDuration > 0 && progress.timemark) {
          const elapsed = timemarkToSeconds(progress.timemark);
          percent = Math.min(99, Math.round((elapsed / totalDuration) * 100));
        }

        if (percent !== lastPercent) {
          lastPercent = percent;
          updateJob(jobId, { status: 'converting', percent });
        }
      })
      .on('end', () => {
        release();
        updateJob(jobId, { status: 'done', percent: 100 });
        resolve();
      })
      .on('error', (err) => {
        release();
        const friendly = sanitizeError(err.message);
        console.error(`[converter] Job ${jobId} failed:`, err.message);
        updateJob(jobId, { status: 'failed', error: friendly });
        resolve();
      })
      .save(job.outputPath);
  });
}

module.exports = { startConversion };
