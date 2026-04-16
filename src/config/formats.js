'use strict';

/**
 * Central format registry.
 * outputFormat  — the name passed to FFmpeg's -f flag (may differ from the key, e.g. mkv→matroska)
 * ext           — file extension including the dot
 * mime          — Content-Type for HTTP download response
 * label         — display name shown in the UI
 * videoCodec    — FFmpeg -vcodec value
 * audioCodec    — FFmpeg -acodec value
 * outputOptions — extra FFmpeg flags specific to this container/codec
 * slower        — true when encoding is noticeably slower than H.264 (UI hint)
 */
const FORMATS = {
  avi: {
    outputFormat:  'avi',
    ext:           '.avi',
    mime:          'video/x-msvideo',
    label:         'AVI',
    videoCodec:    'mpeg4',
    audioCodec:    'libmp3lame',
    outputOptions: ['-vtag xvid', '-qscale:v 4', '-qscale:a 5', '-ar 44100'],
  },
  mp4: {
    outputFormat:  'mp4',
    ext:           '.mp4',
    mime:          'video/mp4',
    label:         'MP4',
    videoCodec:    'libx264',
    audioCodec:    'aac',
    outputOptions: ['-crf 23', '-preset medium', '-movflags +faststart'],
  },
  mkv: {
    outputFormat:  'matroska',   // FFmpeg's canonical name for MKV
    ext:           '.mkv',
    mime:          'video/x-matroska',
    label:         'MKV',
    videoCodec:    'libx264',
    audioCodec:    'aac',
    outputOptions: ['-crf 23', '-preset medium'],
  },
  mov: {
    outputFormat:  'mov',
    ext:           '.mov',
    mime:          'video/quicktime',
    label:         'MOV',
    videoCodec:    'libx264',
    audioCodec:    'aac',
    outputOptions: ['-crf 23', '-preset medium', '-movflags +faststart'],
  },
  webm: {
    outputFormat:  'webm',
    ext:           '.webm',
    mime:          'video/webm',
    label:         'WebM',
    videoCodec:    'libvpx-vp9',
    audioCodec:    'libopus',
    outputOptions: ['-crf 33', '-b:v 0', '-deadline good', '-cpu-used 2'],
    slower:        true,
  },
};

/**
 * Extensions accepted as input.
 * Magic-byte validation on the server provides the real security layer;
 * this set is a first-pass filter for obviously wrong file types.
 */
const ALLOWED_INPUT_EXTENSIONS = new Set([
  '.mp4', '.m4v',
  '.avi',
  '.mkv',
  '.mov', '.qt',
  '.webm',
  '.flv',
]);

module.exports = { FORMATS, ALLOWED_INPUT_EXTENSIONS };
