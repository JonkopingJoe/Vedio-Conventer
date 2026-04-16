'use strict';

// ─── Format constants (must match src/config/formats.js) ─────────────────────

const FORMAT_LABELS = {
  mp4: 'MP4', avi: 'AVI', mkv: 'MKV', mov: 'MOV', webm: 'WebM', flv: 'FLV',
};

// Output formats available in the picker (order = display order)
const OUTPUT_FORMATS = ['avi', 'mp4', 'mkv', 'mov', 'webm'];

// Slower-to-encode formats (VP9 etc.) — shown as "· slower" hint
const SLOWER_FORMATS = new Set(['webm']);

// Smart default output for each detected input format
const SMART_DEFAULTS = {
  mp4: 'avi', m4v: 'avi',
  avi: 'mp4',
  mkv: 'mp4',
  mov: 'mp4', qt: 'mp4',
  webm: 'mp4',
  flv: 'mp4',
};

// Extensions accepted on the client (mirrors ALLOWED_INPUT_EXTENSIONS on the server)
const ALLOWED_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.avi', '.mkv', '.mov', '.qt', '.webm', '.flv',
]);

// Extension → format key
const EXTENSION_MAP = {
  '.mp4': 'mp4', '.m4v': 'mp4',
  '.avi': 'avi',
  '.mkv': 'mkv',
  '.mov': 'mov', '.qt': 'mov',
  '.webm': 'webm',
  '.flv': 'flv',
};

// ─── App state ────────────────────────────────────────────────────────────────

let selectedFile   = null;
let currentJobId   = null;
let eventSource    = null;
let detectedFormat = null;        // detected input format key, or null
let selectedFormat = 'avi';       // chosen output format key
let focusedOptIdx  = -1;          // keyboard-focused option index in the dropdown

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const fileInput        = document.getElementById('file-input');
const selectBtn        = document.getElementById('select-btn');
const dropZone         = document.getElementById('drop-zone');

const removeBtn        = document.getElementById('remove-btn');
const convertBtn       = document.getElementById('convert-btn');
const fileName         = document.getElementById('file-name');
const fileSize         = document.getElementById('file-size');
const sourceBadge      = document.getElementById('source-badge');
const formatFromBox    = document.getElementById('format-from-box');

const formatTrigger    = document.getElementById('format-trigger');
const formatTrigLabel  = document.getElementById('format-trigger-label');
const formatDropdown   = document.getElementById('format-dropdown');

const sameFormatBanner = document.getElementById('same-format-banner');
const sameFormatText   = document.getElementById('same-format-text');
const sizeWarning      = document.getElementById('size-warning');

const uploadBar        = document.getElementById('upload-bar');
const uploadPercent    = document.getElementById('upload-percent');
const uploadBarCont    = document.getElementById('upload-bar-container');

const convertBar       = document.getElementById('convert-bar');
const convertPercent   = document.getElementById('convert-percent');
const convertBarCont   = document.getElementById('convert-bar-container');
const convertingLabel  = document.getElementById('converting-label');

const downloadBtn      = document.getElementById('download-btn');
const downloadBtnLabel = document.getElementById('download-btn-label');
const anotherBtn       = document.getElementById('another-btn');

const retryBtn         = document.getElementById('retry-btn');
const errorMessage     = document.getElementById('error-message');

// ─── State machine ────────────────────────────────────────────────────────────

const STATES = ['idle','selected','uploading','queued','converting','done','error'];

function showState(name) {
  STATES.forEach((s) => {
    const el = document.getElementById(`state-${s}`);
    if (!el) return;
    const active = s === name;
    el.classList.toggle('active', active);
    if (active) {
      el.style.animation = 'none';
      void el.offsetWidth; // force reflow to restart animation
      el.style.animation = '';
    }
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function setProgress(barEl, containerEl, labelEl, pct) {
  barEl.style.width = `${pct}%`;
  if (containerEl) containerEl.setAttribute('aria-valuenow', pct);
  if (labelEl) labelEl.textContent = `${pct}%`;
}

function closeEventSource() {
  if (eventSource) { eventSource.close(); eventSource = null; }
}

// ─── Client-side format detection ─────────────────────────────────────────────

function detectFromExtension(filename) {
  const idx = filename.lastIndexOf('.');
  if (idx === -1) return null;
  return EXTENSION_MAP[filename.slice(idx).toLowerCase()] || null;
}

function readMagicBytes(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const b = new Uint8Array(e.target.result);

      // MP4 / MOV — 'ftyp' box at byte offset 4
      if (b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
        // Distinguish MOV from MP4 via major brand at offset 8
        if (b.length >= 12) {
          const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
          return resolve(brand === 'qt  ' ? 'mov' : 'mp4');
        }
        return resolve('mp4');
      }
      // MKV / WebM — EBML header
      if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return resolve('mkv');
      // AVI — RIFF container
      if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return resolve('avi');
      // FLV
      if (b[0] === 0x46 && b[1] === 0x4C && b[2] === 0x56) return resolve('flv');
      // WMV / ASF
      if (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xB2 && b[3] === 0x75) return resolve('wmv');

      resolve(null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsArrayBuffer(file.slice(0, 16));
  });
}

async function detectFormat(file) {
  // Pass 1: extension (instant)
  const fromExt = detectFromExtension(file.name);
  if (fromExt) { applyDetectedFormat(fromExt); return; }

  // Pass 2: magic bytes (async FileReader)
  try {
    const fromMagic = await readMagicBytes(file);
    applyDetectedFormat(fromMagic); // may be null = unknown
  } catch (_) {
    applyDetectedFormat(null);
  }
}

// ─── Format state management ──────────────────────────────────────────────────

function applyDetectedFormat(fmt) {
  detectedFormat = fmt;

  // Update the format badge in the file row
  if (fmt) {
    sourceBadge.dataset.format = fmt;
    sourceBadge.textContent    = FORMAT_LABELS[fmt] || fmt.toUpperCase();
    sourceBadge.hidden         = false;
  } else {
    sourceBadge.dataset.format = '';
    sourceBadge.textContent    = '?';
    sourceBadge.hidden         = false;
  }

  // Update the FROM read-only box
  formatFromBox.dataset.format = fmt || '';
  formatFromBox.textContent    = fmt ? (FORMAT_LABELS[fmt] || fmt.toUpperCase()) : 'Unknown';

  // Rebuild dropdown so "· original" hints reflect the new detection
  buildDropdown();

  // Set smart default output (avoids same-format by default)
  const smartOut = SMART_DEFAULTS[fmt] || 'mp4';
  applySelectedFormat(smartOut);
}

function applySelectedFormat(fmt) {
  selectedFormat = fmt;

  // Update trigger label
  formatTrigLabel.textContent = FORMAT_LABELS[fmt] || fmt.toUpperCase();

  // Update convert button text
  convertBtn.textContent = `Convert to ${FORMAT_LABELS[fmt] || fmt.toUpperCase()}`;

  // Update aria-selected on all dropdown options
  document.querySelectorAll('.format-option').forEach((opt) => {
    opt.setAttribute('aria-selected', opt.dataset.format === fmt ? 'true' : 'false');
  });

  // Show/hide the 2 GB AVI warning
  updateSizeWarning();

  // Show/hide same-format info banner
  updateSameFormatBanner();
}

function updateSameFormatBanner() {
  if (detectedFormat && selectedFormat === detectedFormat) {
    const label = FORMAT_LABELS[detectedFormat] || detectedFormat.toUpperCase();
    sameFormatText.textContent =
      `${label} → ${label}: the container won't change. ` +
      `The file will be re-encoded, which may adjust quality or file size.`;
    sameFormatBanner.classList.add('visible');
  } else {
    sameFormatBanner.classList.remove('visible');
  }
}

function updateSizeWarning() {
  if (!selectedFile) { sizeWarning.hidden = true; return; }
  const isLarge = selectedFile.size >= 1.8 * 1024 * 1024 * 1024;
  sizeWarning.hidden = !(isLarge && selectedFormat === 'avi');
}

// ─── Format picker dropdown ───────────────────────────────────────────────────

function buildDropdown() {
  formatDropdown.innerHTML = '';
  focusedOptIdx = -1;

  OUTPUT_FORMATS.forEach((fmt) => {
    const li = document.createElement('li');
    li.className = 'format-option';
    li.setAttribute('role', 'option');
    li.setAttribute('data-format', fmt);
    li.setAttribute('aria-selected', fmt === selectedFormat ? 'true' : 'false');

    const isOriginal = fmt === detectedFormat;
    const isSlower   = SLOWER_FORMATS.has(fmt);

    li.innerHTML =
      `<span class="format-option-check" aria-hidden="true">` +
        `<svg width="14" height="14" viewBox="0 0 14 14" fill="none">` +
          `<path d="M2 7l4 4 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>` +
        `</svg>` +
      `</span>` +
      `<span class="format-option-name">${FORMAT_LABELS[fmt]}</span>` +
      `<span class="format-option-ext">.${fmt}</span>` +
      (isOriginal ? `<span class="format-option-hint">· original</span>` : '') +
      (isSlower && !isOriginal ? `<span class="format-option-hint">· slower</span>` : '');

    li.addEventListener('click', () => {
      applySelectedFormat(fmt);
      closePicker();
      formatTrigger.focus();
    });

    formatDropdown.appendChild(li);
  });
}

function openPicker() {
  formatDropdown.classList.add('open');
  formatTrigger.setAttribute('aria-expanded', 'true');
  // Pre-focus the currently selected option
  focusedOptIdx = OUTPUT_FORMATS.indexOf(selectedFormat);
  updateFocusedOption();
}

function closePicker() {
  formatDropdown.classList.remove('open');
  formatTrigger.setAttribute('aria-expanded', 'false');
  focusedOptIdx = -1;
  document.querySelectorAll('.format-option.focused')
    .forEach((el) => el.classList.remove('focused'));
}

function isPickerOpen() {
  return formatDropdown.classList.contains('open');
}

function updateFocusedOption() {
  document.querySelectorAll('.format-option').forEach((el, i) => {
    el.classList.toggle('focused', i === focusedOptIdx);
  });
}

// ─── File selection ───────────────────────────────────────────────────────────

function handleFileChosen(file) {
  if (!file) return;

  // Extension check (client-side pre-filter)
  const ext = file.name.includes('.')
    ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
    : '';
  if (ext && !ALLOWED_EXTENSIONS.has(ext)) {
    showError(`"${ext}" is not supported. Please select MP4, AVI, MKV, MOV, WebM, or FLV.`);
    return;
  }

  selectedFile           = file;
  fileName.textContent   = file.name;
  fileSize.textContent   = formatBytes(file.size);

  // Show selected state immediately; detection updates the badge async
  showState('selected');

  // Detect format (may be instant for known extension, or async for magic bytes)
  detectFormat(file);
}

// ─── Upload + conversion ──────────────────────────────────────────────────────

function startConvert() {
  if (!selectedFile) return;

  const fmt = selectedFormat; // capture at click time

  showState('uploading');
  setProgress(uploadBar, uploadBarCont, uploadPercent, 0);

  const formData = new FormData();
  formData.append('file', selectedFile);
  formData.append('targetFormat', fmt);

  const xhr = new XMLHttpRequest();

  xhr.upload.addEventListener('progress', (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    setProgress(uploadBar, uploadBarCont, uploadPercent, pct);
  });

  xhr.addEventListener('load', () => {
    if (xhr.status === 202) {
      let data;
      try { data = JSON.parse(xhr.responseText); }
      catch (_) { return showError('Unexpected server response.'); }

      currentJobId = data.jobId;
      setProgress(convertBar, convertBarCont, convertPercent, 0);
      showState('queued');
      openEventSource(data.jobId, fmt);
    } else {
      let msg = 'Upload failed. Please try again.';
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch (_) {}
      showError(msg);
    }
  });

  xhr.addEventListener('error', () => showError('Network error. Please check your connection.'));
  xhr.addEventListener('abort', () => showError('Upload was cancelled.'));

  xhr.open('POST', '/api/upload');
  xhr.send(formData);
}

// ─── SSE progress listener ────────────────────────────────────────────────────

function openEventSource(jobId, fmt) {
  closeEventSource();
  eventSource = new EventSource(`/api/progress/${jobId}`);

  eventSource.addEventListener('queued', () => showState('queued'));

  eventSource.addEventListener('progress', (e) => {
    let pct = 0;
    try { pct = JSON.parse(e.data).percent || 0; } catch (_) {}

    const converting = document.getElementById('state-converting');
    if (!converting.classList.contains('active')) {
      convertingLabel.textContent =
        `Converting to ${FORMAT_LABELS[fmt] || fmt.toUpperCase()}…`;
      showState('converting');
    }

    setProgress(convertBar, convertBarCont, convertPercent, pct);
  });

  eventSource.addEventListener('done', () => {
    closeEventSource();
    setProgress(convertBar, convertBarCont, convertPercent, 100);
    downloadBtnLabel.textContent = `Download ${FORMAT_LABELS[fmt] || fmt.toUpperCase()}`;
    showState('done');
  });

  eventSource.addEventListener('error', (e) => {
    closeEventSource();
    let msg = 'Conversion failed. Please try again.';
    try { msg = JSON.parse(e.data).message || msg; } catch (_) {}
    showError(msg);
  });

  eventSource.onerror = () => {
    const active = document.querySelector('.state.active');
    if (active && (active.id === 'state-queued' || active.id === 'state-converting')) {
      closeEventSource();
      showError('Connection lost. Please try again.');
    }
  };
}

// ─── Error state ──────────────────────────────────────────────────────────────

function showError(msg) {
  closeEventSource();
  errorMessage.textContent = msg;
  showState('error');
}

// ─── Reset ────────────────────────────────────────────────────────────────────

function reset() {
  closeEventSource();
  selectedFile   = null;
  currentJobId   = null;
  detectedFormat = null;
  fileInput.value = '';

  // Clear format badge and FROM box
  sourceBadge.hidden         = true;
  sourceBadge.textContent    = '';
  sourceBadge.dataset.format = '';
  formatFromBox.textContent    = '—';
  formatFromBox.dataset.format = '';

  // Rebuild dropdown (clears "· original" hints), reset to AVI
  buildDropdown();
  applySelectedFormat('avi');

  // Hide same-format banner immediately (skip transition on reset)
  sameFormatBanner.classList.remove('visible');

  setProgress(uploadBar, uploadBarCont, uploadPercent, 0);
  setProgress(convertBar, convertBarCont, convertPercent, 0);
  showState('idle');
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

// File selection
selectBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener('change', () => handleFileChosen(fileInput.files[0] || null));

// Drag & drop
dropZone.addEventListener('dragenter', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragover',  (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', (e) => {
  if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('drag-over');
});
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFileChosen(e.dataTransfer?.files[0] || null);
});

// Format picker — open/close
formatTrigger.addEventListener('click', (e) => {
  e.stopPropagation();
  isPickerOpen() ? closePicker() : openPicker();
});

// Format picker — keyboard navigation
formatTrigger.addEventListener('keydown', (e) => {
  const len = OUTPUT_FORMATS.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!isPickerOpen()) { openPicker(); return; }
    const dir = e.key === 'ArrowDown' ? 1 : -1;
    focusedOptIdx = (focusedOptIdx + dir + len) % len;
    updateFocusedOption();
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (!isPickerOpen()) { openPicker(); return; }
    if (focusedOptIdx >= 0) {
      applySelectedFormat(OUTPUT_FORMATS[focusedOptIdx]);
      closePicker();
    }
  } else if (e.key === 'Escape' || e.key === 'Tab') {
    closePicker();
  }
});

// Click outside picker → close
document.addEventListener('click', (e) => {
  if (isPickerOpen() && !formatTrigger.closest('.format-picker-wrap').contains(e.target)) {
    closePicker();
  }
});

// State 2 actions
removeBtn.addEventListener('click', reset);
convertBtn.addEventListener('click', startConvert);

// State 6 (done)
downloadBtn.addEventListener('click', () => {
  if (currentJobId) window.location.href = `/api/download/${currentJobId}`;
});
anotherBtn.addEventListener('click', reset);

// State 7 (error)
retryBtn.addEventListener('click', reset);

// ─── Init ─────────────────────────────────────────────────────────────────────

buildDropdown();
