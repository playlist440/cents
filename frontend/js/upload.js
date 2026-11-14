// Upload with progress. fetch() cannot report upload progress, so the real transport uses
// XMLHttpRequest; the in-browser mock simulates a short progress run and then calls the API.
//
//   const result = await uploadWithProgress('/import', [file], { onProgress: (f) => … });
//   onProgress(fraction 0..1) during the upload; resolves with the parsed JSON like api.js does,
//   rejects with ApiError { status, code, message }. Mutating header X-Cents is sent.

import { api, ApiError, isMockTransport } from './api.js';
import { reducedMotion } from './hooks.js';

export function uploadWithProgress(path, files, { field = 'files', onProgress = () => {}, signal } = {}) {
  if (isMockTransport()) return mockUpload(path, files, onProgress);
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const f of files) form.append(field, f, f.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api' + path);
    xhr.setRequestHeader('X-Cents', '1');
    xhr.withCredentials = true;
    xhr.responseType = 'text';
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.min(1, e.loaded / e.total)); };
    xhr.upload.onload = () => onProgress(1);
    xhr.onerror = () => reject(new ApiError(0, 'offline', 'Geen verbinding met Cents.'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Gestopt.'));
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) { resolve(data); return; }
      if (xhr.status === 401) api.bootstrap().catch(() => {}); // lets api.js run its 401 handler
      if (xhr.status === 413) { reject(new ApiError(413, 'too_large', 'Dit bestand is te groot.')); return; }
      const err = data?.error || {};
      reject(new ApiError(xhr.status, err.code, err.message));
    };
    if (signal) signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

async function mockUpload(path, files, onProgress) {
  const size = files.reduce((s, f) => s + (f.size || 0), 0);
  const ms = reducedMotion() ? 0 : Math.min(1400, 350 + size / 4000);
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    onProgress(Math.min(0.98, (performance.now() - t0) / ms));
    await new Promise((r) => setTimeout(r, 50));
  }
  onProgress(1);
  if (path === '/import') return api.importFiles(files);
  if (path === '/restore') return api.restore(files[0]);
  throw new ApiError(404, 'not_found', 'Niet gevonden.');
}
