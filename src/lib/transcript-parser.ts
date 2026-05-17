/**
 * transcript-parser — wandelt einen "ersten Context-Window"-Drop in Atome um.
 *
 * Erkennt (in dieser Reihenfolge):
 *   • OpenAI Chat-Export (`{messages:[...]}` oder direkter Array von Messages)
 *   • Claude Code Transcript ("Bash <desc>\nIN\n…\nOUT\n…" + <task-notification>)
 *   • Claude Share-Export-Markdown ("**Human:** ... **Assistant:** ...")
 *   • Generisches Markdown mit User/Assistant-Markierungen
 *   • HTML (Tag-Stripping → re-parse)
 *   • Plain-Prompt (alles ein einziger Prompt-Atom)
 *
 * Plus: jedes Atom > MAX_ATOM_BYTES wird in chunks zerlegt, damit Vektor-
 * Retrieval auch bei "1 großer Atom"-Fällen nützlich bleibt.
 */
import type { Atom } from './ctx-shared.ts';
import { slugify } from './ctx-shared.ts';

const MAX_ATOM_BYTES = 4096;
const CHUNK_BYTES = 1200;
const CHUNK_OVERLAP = 200;

export interface ParseOptions {
  /** Container ID, used only as fallback origin tag. */
  containerId?: string;
  /** If the input is plain text with no turn markers, treat it as a single prompt. */
  treatPlainAsPrompt?: boolean;
}

interface TurnLike {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'unknown';
  content: string;
  index: number;
}

export function parseTranscript(raw: string, opts: ParseOptions = {}): Atom[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  // 1. JSON formats
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const fromJson = tryParseJson(trimmed);
    if (fromJson) return chunkLargeAtoms(turnsToAtoms(fromJson));
  }

  // 2. Claude Code transcript shape (task-notification + Bash IN/OUT)
  if (looksLikeClaudeCode(trimmed)) {
    const ccAtoms = parseClaudeCodeTranscript(trimmed);
    if (ccAtoms.length > 0) return chunkLargeAtoms(ccAtoms);
  }

  // 3. Markdown turn markers
  const turns = splitMarkdownTurns(trimmed);
  if (turns.length > 0) return chunkLargeAtoms(turnsToAtoms(turns));

  // 4. HTML? Strip tags and retry once.
  if (looksLikeHtml(trimmed)) {
    const stripped = stripHtml(trimmed);
    if (stripped !== trimmed) {
      // Avoid infinite recursion: parse the stripped text directly.
      const ccAtoms2 = looksLikeClaudeCode(stripped) ? parseClaudeCodeTranscript(stripped) : [];
      if (ccAtoms2.length > 0) return chunkLargeAtoms(ccAtoms2);
      const turns2 = splitMarkdownTurns(stripped);
      if (turns2.length > 0) return chunkLargeAtoms(turnsToAtoms(turns2));
      return chunkLargeAtoms(turnsToAtoms([{ role: 'user', content: stripped, index: 0 }]));
    }
  }

  // 5. Plain prompt fallback (with chunking).
  if (opts.treatPlainAsPrompt ?? true) {
    return chunkLargeAtoms(turnsToAtoms([{ role: 'user', content: trimmed, index: 0 }]));
  }
  return [];
}

function tryParseJson(s: string): TurnLike[] | null {
  let j: unknown;
  try { j = JSON.parse(s); } catch { return null; }

  // OpenAI conversation/export style: { messages: [...] }
  if (j && typeof j === 'object' && Array.isArray((j as any).messages)) {
    return (j as { messages: Array<{ role?: string; content?: unknown }> }).messages
      .map((m, i) => ({ role: normalizeRole(m.role), content: stringifyContent(m.content), index: i }))
      .filter((t) => t.content.length > 0);
  }
  // Direct array of messages
  if (Array.isArray(j)) {
    return (j as Array<{ role?: string; content?: unknown }>)
      .map((m, i) => ({ role: normalizeRole(m.role), content: stringifyContent(m.content), index: i }))
      .filter((t) => t.content.length > 0);
  }
  return null;
}

function stringifyContent(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    // Claude content-block style: [{type:'text',text:...}, ...]
    return c.map((b) => {
      if (typeof b === 'string') return b;
      if (b && typeof b === 'object' && 'text' in b) return String((b as any).text);
      return '';
    }).join('\n').trim();
  }
  return '';
}

function normalizeRole(r: unknown): TurnLike['role'] {
  const s = String(r ?? '').toLowerCase();
  if (s === 'system' || s === 'user' || s === 'assistant' || s === 'tool') return s;
  if (s === 'human') return 'user';
  if (s === 'ai' || s === 'model') return 'assistant';
  return 'unknown';
}

/**
 * Split a markdown-shaped transcript by turn markers. Supports:
 *   **User:** …   **Assistant:** …   **System:** …   **Human:** …
 *   ## User    ## Assistant
 *   > User: …
 */
function splitMarkdownTurns(text: string): TurnLike[] {
  // Accept any combination of *_>#-prefix decorators, optional colon,
  // optional trailing *_ decorators. Covers: **User:**, ## User, > User:,
  // User:, **User:** content (we still strip the marker line).
  const re = /^\s*(?:[*_>#]+\s*)*(User|Human|Assistant|System|AI|Model|Tool)\s*:?\s*[*_]*\s*$/gim;
  // Find marker positions
  const markers: Array<{ role: TurnLike['role']; start: number; end: number }> = [];
  for (const m of text.matchAll(re)) {
    markers.push({
      role: normalizeRole(m[1]),
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    });
  }
  if (markers.length === 0) return [];
  const turns: TurnLike[] = [];
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    const next = markers[i + 1];
    const content = text.slice(m.end, next?.start ?? text.length).trim();
    if (content.length === 0) continue;
    turns.push({ role: m.role, content, index: i });
  }
  return turns;
}

// ──────────────────────────────────────────────────────────────────────
// Claude Code transcript shape — `Bash <desc>\nIN\n<cmd>\nOUT\n<out>`
// blocks interspersed with prose. <task-notification> blocks are noise.
// ──────────────────────────────────────────────────────────────────────

const CC_TOOL_LINE = /^(Bash|Read|Write|Edit|Grep|Glob|MultiEdit|Task|TodoWrite|WebFetch|WebSearch|NotebookEdit|Ran|Probe)\s+(.+?)\s*$/;

export function looksLikeClaudeCode(text: string): boolean {
  // Signal 1: task-notification XML blocks
  if (/<task-notification>[\s\S]*?<\/task-notification>/.test(text)) return true;
  // Signal 2: at least 3 "Bash <desc>\nIN\n" patterns
  const m = text.match(/^(?:Bash|Read|Write|Edit|Grep) [^\n]+\nIN\n/gm);
  return Boolean(m && m.length >= 3);
}

function stripTaskNotifications(text: string): string {
  return text.replace(/<task-notification>[\s\S]*?<\/task-notification>\s*/g, '');
}

function parseClaudeCodeTranscript(raw: string): Atom[] {
  const text = stripTaskNotifications(raw);
  const lines = text.split('\n');

  type Segment =
    | { kind: 'prose'; lines: string[] }
    | { kind: 'tool'; tool: string; desc: string; in: string[]; out: string[] };

  const segments: Segment[] = [];
  let state: 'prose' | 'in' | 'out' = 'prose';
  let current: Segment | null = null;

  const pushProse = (ln: string): void => {
    if (current?.kind !== 'prose') {
      current = { kind: 'prose', lines: [] };
      segments.push(current);
    }
    if (current.kind === 'prose') current.lines.push(ln);
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const toolMatch = state === 'prose' ? CC_TOOL_LINE.exec(ln) : null;
    if (toolMatch) {
      // Start a new tool segment. Peek ahead: next line should be "IN" for this
      // to be a real tool call; otherwise treat as prose.
      const peek = lines[i + 1];
      if (peek === 'IN') {
        current = { kind: 'tool', tool: toolMatch[1], desc: toolMatch[2], in: [], out: [] };
        segments.push(current);
        state = 'in';
        i++; // consume the IN marker
        continue;
      }
      // Fall through as prose
    }
    if (state === 'in') {
      if (ln === 'OUT') { state = 'out'; continue; }
      if (current?.kind === 'tool') current.in.push(ln);
      continue;
    }
    if (state === 'out') {
      // OUT block ends when the next tool line or a blank-then-prose-line appears.
      // Simplest reliable signal: a NEW tool line ends the OUT block.
      const nextTool = CC_TOOL_LINE.exec(ln);
      if (nextTool && lines[i + 1] === 'IN') {
        // Start a new tool — don't consume yet; re-process from prose state
        state = 'prose';
        i--;
        continue;
      }
      if (current?.kind === 'tool') current.out.push(ln);
      continue;
    }
    // state === 'prose'
    pushProse(ln);
  }

  // Materialize atoms
  const atoms: Atom[] = [];
  let toolIdx = 0;
  let proseIdx = 0;
  for (const seg of segments) {
    if (seg.kind === 'prose') {
      const body = seg.lines.join('\n').trim();
      if (body.length < 16) continue; // skip tiny prose fragments
      const path = `prose:${proseIdx}`;
      atoms.push({
        slug: slugify(`${path}#prose`),
        path,
        symbol: `prose-${proseIdx}`,
        kind: 'transcript-prose',
        body,
        title: `prose ${proseIdx}`,
        frontmatter: { prose_index: String(proseIdx) },
      });
      proseIdx++;
    } else {
      const cmd = seg.in.join('\n').trim();
      const out = seg.out.join('\n').trim();
      // Separate atoms for command and output — both are useful retrieval targets
      // (debugging "what command did I run for X" vs "what was the output of Y")
      const path = `tool:${toolIdx}:${seg.tool.toLowerCase()}`;
      const symbol = sluglikeSymbol(seg.desc) || `${seg.tool.toLowerCase()}-${toolIdx}`;
      if (cmd.length > 0) {
        atoms.push({
          slug: slugify(`${path}#cmd`),
          path,
          symbol: `${symbol}-cmd`,
          kind: 'tool-cmd',
          body: cmd,
          title: `${seg.tool}: ${seg.desc}`,
          frontmatter: { tool: seg.tool, desc: seg.desc, tool_index: String(toolIdx) },
        });
      }
      if (out.length > 0) {
        atoms.push({
          slug: slugify(`${path}#out`),
          path,
          symbol: `${symbol}-out`,
          kind: 'tool-out',
          body: out,
          title: `${seg.tool} output: ${seg.desc}`,
          frontmatter: { tool: seg.tool, desc: seg.desc, tool_index: String(toolIdx) },
        });
      }
      toolIdx++;
    }
  }
  return atoms;
}

function sluglikeSymbol(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

// ──────────────────────────────────────────────────────────────────────
// HTML detection + stripping (best-effort)
// ──────────────────────────────────────────────────────────────────────

function looksLikeHtml(text: string): boolean {
  if (/<!DOCTYPE\s+html/i.test(text)) return true;
  if (/<html[\s>]/i.test(text)) return true;
  // Many tags? rough threshold.
  const tagCount = (text.match(/<\/?[a-z][a-z0-9-]*[^>]*>/gi) ?? []).length;
  return tagCount > 20 && tagCount > text.length / 200;
}

function stripHtml(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?(p|div|li|h[1-6]|tr|td|th|br|section|article|header|footer|nav)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ──────────────────────────────────────────────────────────────────────
// Universal safety net: chunk any atom whose body exceeds MAX_ATOM_BYTES.
// Sliding-window chunks with overlap so semantic edges aren't lost.
// ──────────────────────────────────────────────────────────────────────

function chunkLargeAtoms(atoms: Atom[]): Atom[] {
  const out: Atom[] = [];
  for (const a of atoms) {
    if (a.body.length <= MAX_ATOM_BYTES) {
      out.push(a);
      continue;
    }
    // Split with overlap. Prefer line boundaries when possible.
    let start = 0;
    let chunkIdx = 0;
    while (start < a.body.length) {
      let end = Math.min(start + CHUNK_BYTES, a.body.length);
      // Snap end to the nearest newline within last 200 chars to avoid
      // splitting mid-sentence.
      if (end < a.body.length) {
        const nl = a.body.lastIndexOf('\n', end);
        if (nl > start + CHUNK_BYTES / 2) end = nl;
      }
      const slice = a.body.slice(start, end);
      out.push({
        ...a,
        slug: slugify(`${a.path}#chunk-${chunkIdx}`),
        symbol: `${a.symbol}-chunk-${chunkIdx}`,
        body: slice,
        title: `${a.title} (chunk ${chunkIdx})`,
        frontmatter: {
          ...(a.frontmatter ?? {}),
          chunk_index: String(chunkIdx),
          chunk_offset: String(start),
          chunk_total_bytes: String(a.body.length),
        },
      });
      if (end >= a.body.length) break;
      start = Math.max(start + 1, end - CHUNK_OVERLAP);
      chunkIdx++;
    }
  }
  return out;
}

function turnsToAtoms(turns: TurnLike[]): Atom[] {
  const out: Atom[] = [];
  for (const t of turns) {
    const symbol = `turn-${t.index}-${t.role}`;
    const path = `turn:${t.index}:${t.role}`;
    // Extract code blocks
    const blocks: Array<{ lang: string; code: string; start: number; end: number }> = [];
    const cb = /```(\w*)\n([\s\S]*?)```/g;
    let mm: RegExpExecArray | null;
    while ((mm = cb.exec(t.content)) !== null) {
      blocks.push({ lang: mm[1] || 'text', code: mm[2], start: mm.index, end: mm.index + mm[0].length });
    }

    // Body of the turn with code blocks elided (for prose retrieval signal)
    let prose = t.content;
    if (blocks.length > 0) {
      const parts: string[] = [];
      let cursor = 0;
      for (const b of blocks) {
        parts.push(t.content.slice(cursor, b.start));
        parts.push(`[code-block:${b.lang}]`);
        cursor = b.end;
      }
      parts.push(t.content.slice(cursor));
      prose = parts.join('').trim();
    }

    if (prose.length > 0) {
      out.push({
        slug: slugify(`${path}#prose`),
        path,
        symbol,
        kind: t.role === 'system' ? 'prompt-system' : `turn-${t.role}`,
        body: prose,
        title: `${t.role} turn ${t.index}`,
        frontmatter: { role: t.role, turn_index: String(t.index) },
      });
    }

    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi];
      out.push({
        slug: slugify(`${path}#code-${bi}-${b.lang}`),
        path: `${path}#code-${bi}`,
        symbol: `code-${bi}-${b.lang}`,
        kind: 'code-block',
        body: b.code,
        title: `${b.lang} block in turn ${t.index}`,
        frontmatter: { role: t.role, turn_index: String(t.index), lang: b.lang },
      });
    }
  }
  return out;
}
