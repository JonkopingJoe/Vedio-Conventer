'use strict';

require('dotenv').config();

const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const path    = require('path');

const uploadRouter   = require('./src/routes/upload');
const progressRouter = require('./src/routes/progress');
const downloadRouter = require('./src/routes/download');

const { uploadLimiter }     = require('./src/middleware/rateLimiter');
const { startCleanup }      = require('./src/services/cleanup');
const { recoverStalledJobs } = require('./src/services/jobStore');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Security headers ────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'"],
      styleSrc:    ["'self'", 'https://fonts.googleapis.com'],
      fontSrc:     ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:      ["'self'", 'data:'],
      connectSrc:  ["'self'"],
      objectSrc:   ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false, // allow font loading
}));

// ─── CORS ────────────────────────────────────────────────────────────────────
// In production, restrict to same origin.
// In development, allow localhost on any port.
const corsOrigin = process.env.NODE_ENV === 'production'
  ? process.env.ALLOWED_ORIGIN || false  // false = same-origin only
  : true;

app.use(cors({ origin: corsOrigin }));

// ─── Body parsing ─────────────────────────────────────────────────────────────
// Note: file uploads are handled by Multer in the upload route, not here.
app.use(express.json());

// ─── Static frontend ─────────────────────────────────────────────────────────
// In production Nginx serves public/ directly.
// In development Express serves it so everything works with one process.
app.use(express.static(path.join(__dirname, 'public')));

// ─── API routes ───────────────────────────────────────────────────────────────
app.use('/api/upload',   uploadLimiter, uploadRouter);
app.use('/api/progress', progressRouter);
app.use('/api/download', downloadRouter);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status:  'ok',
    uptime:  process.uptime(),
    time:    new Date().toISOString(),
  });
});

// ─── 404 for unknown API routes ───────────────────────────────────────────────
app.use('/api/*path', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// ─── Global error handler ─────────────────────────────────────────────────────
// Must have 4 parameters so Express recognises it as an error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Multer file-size error
  if (err.code === 'LIMIT_FILE_SIZE') {
    const maxMB = process.env.MAX_FILE_MB || 500;
    return res.status(413).json({
      error: `File too large. Maximum size is ${maxMB} MB.`,
    });
  }

  // Multer unexpected field
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: 'Unexpected file field.' });
  }

  console.error('[error]', err.message);

  res.status(500).json({ error: 'An internal error occurred.' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[mp4tool] Server running on http://localhost:${PORT}`);
  console.log(`[mp4tool] Environment: ${process.env.NODE_ENV || 'development'}`);
  recoverStalledJobs();
  startCleanup();
});

module.exports = app; // exported for testing
