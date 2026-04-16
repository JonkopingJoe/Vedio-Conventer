# MP4Tool — Features & Design

A browser-based video format converter. No account, no installation, no file retention beyond one hour.

---

## Design Philosophy

**Privacy by default.** Files are processed on-server and deleted automatically after 60 minutes. No analytics, no tracking, no third-party data processors beyond Google Fonts (a CDN, not a tracker).

**Zero friction.** One page, one action. A user who has never heard of video codecs should be able to convert a file in under 30 seconds without reading any documentation.

**Honest UX.** The interface tells the truth: it shows what format was detected, flags same-format conversions, warns about the AVI 2 GB ceiling, and surfaces friendly error messages instead of raw FFmpeg output.

**Security without complexity.** Every upload goes through two independent validation layers (extension filter + magic byte check) before FFmpeg ever sees the file. Inputs are never executed or interpolated into shell commands. Filenames are discarded and replaced with deterministic safe names.

**Stateless frontend, stateful backend.** The frontend is a plain HTML/CSS/JS single page — no framework, no build step, no node_modules on the client. State lives in memory on the server and is communicated back via Server-Sent Events.

---

## Features

### Format Support

| Input accepted | Output formats |
|---|---|
| MP4, M4V, AVI, MKV, MOV, QT, WebM, FLV | MP4, AVI, MKV, MOV, WebM |

Input validation is dual-layer: client-side extension check for instant UX feedback, and server-side magic byte inspection before the file enters the conversion pipeline.

### Automatic Input Format Detection

When a file is selected, the client detects the container format and shows it in a read-only "From" box:

1. **Extension lookup** (synchronous) — covers the common case immediately, so the badge appears without any perceived delay.
2. **Magic byte fallback** (async FileReader, reads first 16 bytes) — catches files with wrong or missing extensions by checking container signatures: `ftyp` box (MP4/MOV), EBML header (MKV/WebM), `RIFF` header (AVI), `FLV\x01` marker, ASF GUID (WMV).

### Smart Default Output Format

The output picker defaults to the most useful target for each detected input:

| Input | Default output |
|---|---|
| MP4, M4V | AVI |
| AVI | MP4 |
| MKV, MOV, QT, WebM, FLV | MP4 |

This avoids the trivially useless same-format default while still making a sensible guess.

### Format Picker

A keyboard-accessible custom dropdown lets users choose from all five output formats. Each option shows:

- A checkmark when selected
- `· original` when the format matches the detected input
- `· slower` for VP9/WebM, which is noticeably slower to encode

Full keyboard support: `ArrowUp`/`ArrowDown` to navigate, `Enter`/`Space` to select, `Escape`/`Tab` to close. Click-outside dismisses without selection.

### Same-Format Info Banner

When the chosen output matches the detected input (e.g. MP4 → MP4), a blue info banner appears inline:

> *MP4 → MP4: the container won't change. The file will be re-encoded, which may adjust quality or file size.*

This is intentionally styled as informational (blue), not a warning or an error — the conversion is valid, the user just deserves to know what will happen.

### AVI 2 GB Warning

AVI is limited by the original RIFF specification to ~2 GB. If the source file exceeds 1.8 GB and the target is AVI, a warning appears before conversion starts.

### Real-Time Progress

Conversion progress is streamed to the browser via Server-Sent Events (not polling). The SSE connection carries four event types:

| Event | Payload |
|---|---|
| `queued` | `{ position }` — queue depth behind this job |
| `progress` | `{ percent }` — 0–99 during conversion |
| `done` | `{ jobId }` — triggers download prompt |
| `error` | `{ message }` — user-facing error string |

Progress percentage uses `ffmpeg.progress.percent` when available, falling back to `timemark / totalDuration` derived from a pre-conversion ffprobe call when `percent` is NaN (common for VP9).

### Conversion Pipeline

Each format maps to a fixed set of FFmpeg parameters in `src/config/formats.js`:

| Format | Video codec | Audio codec | Notable flags |
|---|---|---|---|
| AVI | mpeg4 + xvid tag | libmp3lame | `-qscale:v 4 -ar 44100` (VBR MP3 reliability) |
| MP4 | libx264 | aac | `-crf 23 -preset medium -movflags +faststart` |
| MKV | libx264 | aac | `-crf 23 -preset medium` |
| MOV | libx264 | aac | `-crf 23 -preset medium -movflags +faststart` |
| WebM | libvpx-vp9 | libopus | `-crf 33 -b:v 0 -deadline good -cpu-used 2` |

Adding a new output format requires a single entry in the `FORMATS` object and a corresponding entry in the client-side `FORMAT_LABELS`/`OUTPUT_FORMATS` constants — no other code changes needed.

### Concurrency Control

A promise-based counting semaphore limits simultaneous FFmpeg processes (`MAX_CONCURRENT_JOBS`, default 3). Jobs exceeding the limit queue transparently; the client shows a "Waiting in queue…" state with an indeterminate progress bar.

### Automatic Cleanup

A node-cron job runs every 30 minutes and deletes:
- All job directories whose `createdAt` exceeds `JOB_TTL_MINUTES` (default 60 min)
- Any orphaned `tmp/` subdirectories not tracked in the in-memory job store (crash recovery)

### Security

- **Helmet** sets Content-Security-Policy, `X-Content-Type-Options`, `Strict-Transport-Security`, `Referrer-Policy`, and other defensive headers.
- **Rate limiting** on the upload endpoint: 5 requests per 10-minute window per IP (configurable via env).
- **Magic byte validation** rejects non-video files regardless of extension, protecting FFmpeg from malformed or intentionally crafted inputs.
- **UUID v4 job IDs** mean job URLs are unguessable; there is no sequential ID to enumerate.
- **No shell interpolation**: all FFmpeg invocations go through fluent-ffmpeg's programmatic API, never a shell command string.
- **CSP** blocks inline scripts, eval, and external script sources entirely.

### Environment Configuration

All tunable parameters are in `.env` (see `.env.example`):

```
PORT=3000
NODE_ENV=development
MAX_FILE_MB=500
MAX_CONCURRENT_JOBS=3
JOB_TTL_MINUTES=60
CLEANUP_INTERVAL_MINUTES=30
RATE_LIMIT_WINDOW_MINUTES=10
RATE_LIMIT_MAX_REQUESTS=5
```

---

## UI States

The single-page interface transitions through 7 discrete states:

| State | What the user sees |
|---|---|
| **Idle** | Drop zone with upload icon and "Select Video File" button |
| **Selected** | File name, size, detected format badge, format picker, convert button |
| **Uploading** | Progress bar with percentage |
| **Queued** | Indeterminate bar, "Waiting in queue…" message |
| **Converting** | Progress bar with percentage, "Converting to [FORMAT]…" label |
| **Done** | Success icon, "Download [FORMAT]" button, "Convert another file" link |
| **Error** | Error icon, user-friendly message, "Try again" button |

State transitions are animated with a CSS `fadeSlideUp` keyframe. The animation is reset on each transition using a forced reflow trick (`void el.offsetWidth`) so re-entering the same state still plays the animation.

---

## Project Structure

```
mp4tool/
├── server.js                   # Entry point, Express setup, route mounting
├── public/
│   ├── index.html              # Single-page UI (no framework)
│   ├── css/style.css           # All styles, including format picker and state transitions
│   └── js/app.js               # All client logic, format detection, SSE, state machine
├── src/
│   ├── config/
│   │   └── formats.js          # Central format registry (codec params, MIME types, extensions)
│   ├── middleware/
│   │   ├── uploader.js         # Multer config, extension filter, magic byte validator
│   │   └── rateLimiter.js      # express-rate-limit config
│   ├── routes/
│   │   ├── upload.js           # POST /api/upload
│   │   ├── progress.js         # GET /api/progress/:jobId (SSE)
│   │   └── download.js         # GET /api/download/:jobId
│   └── services/
│       ├── jobStore.js         # In-memory job map + SSE broadcast
│       ├── converter.js        # FFmpeg wrapper, progress calculation, error sanitizer
│       ├── semaphore.js        # Concurrency limiter
│       └── cleanup.js          # Scheduled temp file deletion
├── tmp/                        # Runtime job directories (gitignored)
├── .env.example
└── package.json
```

---

## Potential Future Improvements

### Core Functionality

- **Audio-only extraction** — output MP3/AAC/FLAC from video source files. Requires a separate output type in the format registry and a flag that suppresses the video stream (`-vn`).
- **Resolution / quality controls** — let users pick 1080p / 720p / 480p or a CRF slider. Currently all conversions pass through at source resolution.
- **Trim by time range** — clip the output to a start + end timestamp using FFmpeg's `-ss` / `-to` flags. Pairs naturally with the existing format picker.
- **Custom output filename** — today the download is always `converted.ext`; let users rename it before downloading.
- **Subtitle passthrough** — copy embedded subtitle streams into MKV/MOV containers instead of dropping them silently.
- **Hardware acceleration** — detect available encoders on startup (`ffmpeg -encoders`) and prefer `h264_nvenc` / `h264_videotoolbox` / `h264_vaapi` over libx264 when available, dramatically speeding up MP4/MKV conversions.

### UX

- **Multiple file queue** — accept a batch of files and show per-file progress cards. The backend semaphore already handles concurrency; the main work is in the UI.
- **Drag-to-reorder queue** — when multiple files are queued, allow the user to prioritise them.
- **Estimated time remaining** — calculate ETA from the current progress rate and show it below the progress bar.
- **Download all as ZIP** — when multiple conversions complete, offer a single archive download.
- **Mobile share sheet** — on iOS/Android, add a Web Share Target registration so users can share a video directly from the camera roll to MP4Tool.

### Reliability & Operations

- **Persistent job store** — swap the in-memory `Map` for SQLite (via `better-sqlite3`). Jobs survive server restarts; users can return to a tab after a crash and still download their file.
- **Worker process isolation** — move FFmpeg execution to a child process pool (e.g. `worker_threads` or `child_process.fork`). A crash in one conversion cannot corrupt the job store or kill the HTTP server.
- **Structured logging** — replace `console.log` with a logger (e.g. `pino`) that emits JSON. Makes log aggregation, alerting, and debugging in production far easier.
- **Metrics endpoint** — expose `/api/metrics` with active/queued job counts, average conversion time per format, and disk usage. Compatible with Prometheus scraping.
- **Health check depth** — extend `/api/health` to include FFmpeg availability check, disk free space, and semaphore state so a load balancer can take the node out of rotation gracefully.

### Security & Deployment

- **HTTPS termination** — add Nginx config (or Caddy Caddyfile) with automatic Let's Encrypt certificate renewal for self-hosted deployment.
- **Signed download URLs** — instead of a bare UUID, issue a short-lived HMAC-signed token for the download URL. Prevents a race window where a guessed UUID could be downloaded before the rightful user.
- **Content-Disposition filename** — preserve the original filename in the `Content-Disposition` header (`converted-myvideo.mkv` instead of `converted.mkv`).
- **Docker image** — a multi-stage `Dockerfile` that builds on `node:22-slim` with FFmpeg installed from a pinned APT snapshot, yielding a reproducible ~200 MB image.
- **CI pipeline** — GitHub Actions workflow: lint → unit tests (Jest) → Docker build → push to GHCR on merge to `main`.
