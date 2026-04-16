'use strict';

const rateLimit = require('express-rate-limit');

const uploadLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MINUTES || '10', 10) * 60 * 1000,
  limit:    parseInt(process.env.RATE_LIMIT_MAX_REQUESTS   || '5',  10),
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  message: { error: 'Too many requests. Please try again in a few minutes.' },
});

module.exports = { uploadLimiter };
