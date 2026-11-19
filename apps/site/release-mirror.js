// dusk.bot's own copy of each release's installers and mac update zips, so a GitHub outage or a network that can't
// reach GitHub never blocks an update. scripts/mirror-release.sh puts them in DUSK_RELEASE_MIRROR/<version>/ under the
// names SHA256SUMS gives them, outside the deployed site so a deploy never drops them. the signed latest.json and
// SHA256SUMS still vouch for every byte. a single Range is honoured: the desktop app resumes a broken download.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export const MIRRORED = /^\/releases\/(\d+\.\d+\.\d+)\/((?:Metal|DuskBot)-\1-[A-Za-z0-9_.-]+\.(?:zip|dmg|exe|deb|AppImage))$/;

/** the start and end (inclusive) a Range header asks for in a file of `size` bytes; null for the whole file, false when unsatisfiable */
export function byteRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  return start > end || start >= size ? false : { start, end };
}

// the built-in voice's model files, one folder per sha256 (scripts/mirror-voice-models.sh), so a first call never
// depends on Hugging Face or GitHub; the app checks every byte against the same hash it asked for
export const VOICE_MODEL = /^\/voice\/([0-9a-f]{64})\/([A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:onnx|json|bin))$/;

/** answers a mirrored release file and returns true, or returns false for any other address */
export function serveMirrored(req, res, urlPath, root = process.env.DUSK_RELEASE_MIRROR || '/var/lib/dusk-releases') {
  const m = MIRRORED.exec(urlPath);
  if (!m) return false;
  return serveFile(req, res, path.join(root, m[1], m[2]), m[2]);
}

/** answers a mirrored voice model file and returns true, or returns false for any other address */
export function serveVoiceModel(req, res, urlPath, root = process.env.DUSK_VOICE_MIRROR || '/var/lib/dusk-voice') {
  const m = VOICE_MODEL.exec(urlPath);
  if (!m) return false;
  return serveFile(req, res, path.join(root, m[1], m[2]), m[2]);
}

function serveFile(req, res, file, name) {
  const st = fs.statSync(file, { throwIfNoEntry: false });
  if (!st?.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('not found\n');
    return true;
  }
  const range = byteRange(req.headers.range, st.size);
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    // a release file never changes under its versioned name
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Disposition': `attachment; filename="${name}"`,
    'Last-Modified': st.mtime.toUTCString(),
  };
  if (range === false) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${st.size}`, 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }
  const { start, end } = range ?? { start: 0, end: st.size - 1 };
  res.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': String(end - start + 1), ...(range ? { 'Content-Range': `bytes ${start}-${end}/${st.size}` } : {}) });
  if (req.method === 'HEAD') { res.end(); return true; }
  pipeline(fs.createReadStream(file, { start, end }), res).catch(() => res.destroy());
  return true;
}
