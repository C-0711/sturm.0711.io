/**
 * pdf-bbox — Word-level bounding box extraction via Poppler `pdftotext`.
 *
 * Liefert für einen Snippet-String die passenden Word-Bounding-Boxen auf
 * einer PDF-Seite, normalisiert auf Prozente der Seitendimension. Damit
 * kann das Frontend einen absolut-positionierten Overlay über das gerenderte
 * PNG legen (gelbe Markierung).
 *
 * Funktioniert nur für "born-digital" PDFs mit echtem Text-Layer (ELSTER,
 * BMF-Bescheide). Bei reinen Bild-PDFs (Scans) liefert pdftotext nichts —
 * dann wird ein leeres Result zurückgegeben (keine Markierung).
 *
 * Algorithmus:
 *   1. `pdftotext -bbox-layout -f N -l N <pdf> -` → HTML mit <word>-Tags
 *   2. Parse: Liste von {text, xMin, yMin, xMax, yMax}
 *   3. Snippet in normalisierte Tokens zerlegen
 *   4. Finde im Word-Stream die längste/beste matching Subsequenz
 *   5. Convertiere Pixel-Koord → %, gruppiere benachbarte Words zu Zeilen
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface BboxMatch {
  /** Linker Rand in % der Seitenbreite. */
  xPct: number;
  /** Oberer Rand in % der Seitenhöhe. */
  yPct: number;
  /** Breite in % der Seitenbreite. */
  wPct: number;
  /** Höhe in % der Seitenhöhe. */
  hPct: number;
  /** Gematchter Text. */
  text: string;
}

interface Word {
  text: string;
  xMin: number; yMin: number; xMax: number; yMax: number;
}

/** Normalize a token for fuzzy matching: lowercase, only alphanumerics. */
function normTok(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Parse pdftotext -bbox-layout HTML output into a word list + page dims. */
function parseBboxHtml(html: string): { words: Word[]; pageW: number; pageH: number } {
  // <page width="595.276001" height="841.890015">
  //   <flow><block><line><word xMin="..." yMin="..." xMax="..." yMax="...">text</word>…
  const pageMatch = html.match(/<page[^>]*width="([0-9.]+)"[^>]*height="([0-9.]+)"/);
  const pageW = pageMatch ? Number(pageMatch[1]) : 595;
  const pageH = pageMatch ? Number(pageMatch[2]) : 842;
  const words: Word[] = [];
  // word tag: <word xMin="..." yMin="..." xMax="..." yMax="...">text</word>
  const re = /<word\s+xMin="([0-9.]+)"\s+yMin="([0-9.]+)"\s+xMax="([0-9.]+)"\s+yMax="([0-9.]+)">([^<]*)<\/word>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const text = m[5]
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    words.push({
      text,
      xMin: Number(m[1]), yMin: Number(m[2]),
      xMax: Number(m[3]), yMax: Number(m[4]),
    });
  }
  return { words, pageW, pageH };
}

/** Find the best matching subsequence of words for the snippet tokens.
 *  Returns indices [start, end] (inclusive). */
function findBestMatch(words: Word[], snippetTokens: string[]): { start: number; end: number } | null {
  if (snippetTokens.length === 0 || words.length === 0) return null;
  const normalized = words.map((w) => normTok(w.text));
  // Greedy: find first occurrence of any token from snippet, then walk forward
  // collecting matches until snippet tokens are exhausted (with bounded skip).
  const SKIP_LIMIT = 5; // allow up to 5 non-matching words between snippet tokens
  let best: { start: number; end: number; score: number } | null = null;
  for (let i = 0; i < normalized.length; i++) {
    if (!snippetTokens.includes(normalized[i])) continue;
    let matched = 0;
    let last = i;
    let skipsSinceLast = 0;
    let snippetIdx = 0;
    // Walk: each snippet token must appear in order, with bounded skip.
    for (let j = i; j < normalized.length && snippetIdx < snippetTokens.length; j++) {
      if (normalized[j] === snippetTokens[snippetIdx]) {
        matched++;
        last = j;
        skipsSinceLast = 0;
        snippetIdx++;
      } else if (matched > 0) {
        skipsSinceLast++;
        if (skipsSinceLast > SKIP_LIMIT) break;
      }
    }
    if (matched < 2) continue; // require at least 2 word matches
    const score = matched / snippetTokens.length;
    if (!best || score > best.score) {
      best = { start: i, end: last, score };
      // Perfect match: stop
      if (score >= 0.95) break;
    }
  }
  return best;
}

/** Group consecutive words into per-line bounding boxes. */
function groupIntoLines(words: Word[]): Array<{ xMin: number; yMin: number; xMax: number; yMax: number; text: string }> {
  if (words.length === 0) return [];
  const lines: Array<{ xMin: number; yMin: number; xMax: number; yMax: number; text: string }> = [];
  let current = { ...words[0], text: words[0].text };
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    // same line if vertical overlap > 50%
    const overlap = Math.min(current.yMax, w.yMax) - Math.max(current.yMin, w.yMin);
    const wh = Math.max(current.yMax - current.yMin, w.yMax - w.yMin);
    if (overlap > wh * 0.5) {
      current.xMin = Math.min(current.xMin, w.xMin);
      current.yMin = Math.min(current.yMin, w.yMin);
      current.xMax = Math.max(current.xMax, w.xMax);
      current.yMax = Math.max(current.yMax, w.yMax);
      current.text += ' ' + w.text;
    } else {
      lines.push(current);
      current = { ...w, text: w.text };
    }
  }
  lines.push(current);
  return lines;
}

/** Tesseract HOCR auf gecachtem PNG. Bbox-Koords sind in Pixel relativ
 *  zum PNG — wir konvertieren zu % der Image-Dim. */
async function tesseractWordsFromPng(
  pngPath: string,
): Promise<{ words: Word[]; pageW: number; pageH: number }> {
  let hocr = '';
  try {
    const { stdout } = await execFileP('tesseract', [pngPath, '-', '-l', 'deu', 'hocr'],
      { maxBuffer: 16 * 1024 * 1024 });
    hocr = stdout;
  } catch {
    return { words: [], pageW: 0, pageH: 0 };
  }
  // Page bbox: <div class='ocr_page' ... title='image "..."; bbox 0 0 W H; ppageno 0'>
  const pageMatch = hocr.match(/class=['"]ocr_page['"][^>]*title=['"][^'"]*?bbox\s+0\s+0\s+(\d+)\s+(\d+)/);
  const pageW = pageMatch ? Number(pageMatch[1]) : 1654;
  const pageH = pageMatch ? Number(pageMatch[2]) : 2339;
  // Word: <span class='ocrx_word' ... title='bbox 100 200 300 250; x_wconf 89'>text</span>
  const words: Word[] = [];
  const re = /<span\s+class=['"]ocrx_word['"][^>]*title=['"]bbox\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)[^'"]*['"][^>]*>([^<]*)<\/span>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(hocr)) !== null) {
    const text = m[5]
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    if (!text.trim()) continue;
    words.push({ text, xMin: Number(m[1]), yMin: Number(m[2]), xMax: Number(m[3]), yMax: Number(m[4]) });
  }
  return { words, pageW, pageH };
}

export async function findSnippetBboxes(
  pdfPath: string,
  page: number,
  snippet: string,
  pngPath?: string,
): Promise<BboxMatch[]> {
  // Tokenize snippet — drop empty / short tokens
  const tokens = snippet
    .split(/\s+/).map(normTok).filter((t) => t.length >= 2);
  if (tokens.length === 0) return [];

  // 1. pdftotext (born-digital, schnell)
  let words: Word[] = [];
  let pageW = 0, pageH = 0;
  try {
    const { stdout } = await execFileP('pdftotext', [
      '-bbox-layout', '-f', String(page), '-l', String(page),
      pdfPath, '-',
    ], { maxBuffer: 8 * 1024 * 1024 });
    const parsed = parseBboxHtml(stdout);
    words = parsed.words; pageW = parsed.pageW; pageH = parsed.pageH;
  } catch { /* fall through */ }

  // 2. Tesseract Fallback wenn kein Text-Layer (Scan / WISO-Raster-Export)
  if (words.length === 0 && pngPath) {
    const parsed = await tesseractWordsFromPng(pngPath);
    words = parsed.words; pageW = parsed.pageW; pageH = parsed.pageH;
  }
  if (words.length === 0) return [];

  const match = findBestMatch(words, tokens);
  if (!match) return [];

  const matched = words.slice(match.start, match.end + 1);
  const lines = groupIntoLines(matched);
  return lines.map((l) => ({
    xPct: (l.xMin / pageW) * 100,
    yPct: (l.yMin / pageH) * 100,
    wPct: ((l.xMax - l.xMin) / pageW) * 100,
    hPct: ((l.yMax - l.yMin) / pageH) * 100,
    text: l.text,
  }));
}
