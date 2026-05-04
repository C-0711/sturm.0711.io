/**
 * Tesseract.js bbox-bridge for STURM.
 *
 * iOS-Live-Text-Style: lazy-load Tesseract.js, run client-side OCR auf einem
 * <img> oder rendered <canvas>, liefert Word-Bboxes mit Pixel-Coords.
 *
 * Cached server-side via POST /api/workspaces/:ws/documents/:uuid/bboxes.
 * Beim 2. Aufruf werden die persistierten Bboxes geladen, kein Re-OCR.
 */

// Verwende unpkg statt jsdelivr — CSP whitelist hat nur unpkg.com.
const TESSERACT_CDN = 'https://unpkg.com/tesseract.js@5/dist/tesseract.min.js';
let _tesseractLoaded = null;

/** Lazy-load Tesseract.js per <script> + Promise. */
export function loadTesseract() {
  if (_tesseractLoaded) return _tesseractLoaded;
  _tesseractLoaded = new Promise((resolve, reject) => {
    if (window.Tesseract) { resolve(window.Tesseract); return; }
    const s = document.createElement('script');
    s.src = TESSERACT_CDN;
    s.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error('Tesseract.js loaded but window.Tesseract undefined'));
    s.onerror = () => reject(new Error(`Failed to load ${TESSERACT_CDN}`));
    document.head.appendChild(s);
  });
  return _tesseractLoaded;
}

/** Run Tesseract on a single image element. Returns {words: [{text,x,y,w,h,confidence}], width, height}. */
export async function ocrImage(imgEl, opts = {}) {
  const Tesseract = await loadTesseract();
  const lang = opts.lang ?? 'deu+eng';
  const onProgress = opts.onProgress ?? (() => {});
  const naturalW = imgEl.naturalWidth;
  const naturalH = imgEl.naturalHeight;
  const result = await Tesseract.recognize(imgEl, lang, {
    logger: (m) => {
      if (m.status === 'recognizing text' && typeof m.progress === 'number') {
        onProgress(m.progress);
      }
    },
  });
  // Tesseract v5: result.data.words[] has {text, bbox: {x0, y0, x1, y1}, confidence}
  const words = (result.data.words ?? []).map((w) => ({
    text: w.text,
    x: w.bbox.x0,
    y: w.bbox.y0,
    w: w.bbox.x1 - w.bbox.x0,
    h: w.bbox.y1 - w.bbox.y0,
    confidence: w.confidence,
  }));
  return { words, width: naturalW, height: naturalH };
}

/** Find words matching a value (substring or token-set match). */
export function findWordsForValue(words, value) {
  if (!value || !Array.isArray(words)) return [];
  const target = value.trim().toLowerCase();
  if (!target) return [];
  // 1. Exact-substring match per word
  const direct = words.filter((w) => w.text.toLowerCase().includes(target));
  if (direct.length > 0) return direct;
  // 2. Multi-token: target hat mehrere Tokens (z.B. "69.291,80 €")
  const tokens = target.split(/\s+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) return [];
  // For each token, find first matching word; return contiguous group
  const matches = [];
  for (const tok of tokens) {
    const m = words.find((w) => w.text.toLowerCase().includes(tok));
    if (m) matches.push(m);
  }
  return matches;
}

/** Build the iOS-style invisible selectable overlay layer. Each word becomes
 *  an absolute-positioned <span> with the text, sized to its bbox.
 *  Transparent text-color so the underlying image shines through, but the
 *  span IS selectable (browser-native text-selection works). */
export function renderSelectableLayer(containerEl, imgEl, bboxes, scale = 1) {
  const layer = document.createElement('div');
  layer.className = 'iostext-layer';
  Object.assign(layer.style, {
    position: 'absolute', left: '0', top: '0',
    width: imgEl.clientWidth + 'px', height: imgEl.clientHeight + 'px',
    pointerEvents: 'none',
  });
  const sx = imgEl.clientWidth / imgEl.naturalWidth;
  const sy = imgEl.clientHeight / imgEl.naturalHeight;
  for (const w of bboxes) {
    const span = document.createElement('span');
    span.textContent = w.text;
    Object.assign(span.style, {
      position: 'absolute',
      left: (w.x * sx) + 'px',
      top: (w.y * sy) + 'px',
      width: (w.w * sx) + 'px',
      height: (w.h * sy) + 'px',
      color: 'transparent',
      caretColor: 'transparent',
      lineHeight: (w.h * sy) + 'px',
      fontSize: (w.h * sy * 0.85) + 'px',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      pointerEvents: 'auto',
      userSelect: 'text',
      cursor: 'text',
      // For DEBUG: outline: '1px solid rgba(255,0,0,0.2)',
    });
    layer.appendChild(span);
  }
  containerEl.appendChild(layer);
  return layer;
}

/** Render a permanent highlight rectangle for a citation match. */
export function renderHighlight(containerEl, imgEl, bboxes, color = 'rgba(255, 220, 0, 0.55)') {
  if (!bboxes || bboxes.length === 0) return null;
  const sx = imgEl.clientWidth / imgEl.naturalWidth;
  const sy = imgEl.clientHeight / imgEl.naturalHeight;
  // Compute bounding rect over all matched words
  const xMin = Math.min(...bboxes.map((b) => b.x));
  const yMin = Math.min(...bboxes.map((b) => b.y));
  const xMax = Math.max(...bboxes.map((b) => b.x + b.w));
  const yMax = Math.max(...bboxes.map((b) => b.y + b.h));
  const div = document.createElement('div');
  div.className = 'iostext-highlight';
  Object.assign(div.style, {
    position: 'absolute',
    left: (xMin * sx - 2) + 'px',
    top: (yMin * sy - 2) + 'px',
    width: ((xMax - xMin) * sx + 4) + 'px',
    height: ((yMax - yMin) * sy + 4) + 'px',
    background: color,
    pointerEvents: 'none',
    borderRadius: '3px',
    transition: 'all 0.2s',
    zIndex: '10',
    mixBlendMode: 'multiply',
  });
  containerEl.appendChild(div);
  // Scroll into view
  div.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return div;
}
