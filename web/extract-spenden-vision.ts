/**
 * web/extract-spenden-vision — Vision-OCR-Fallback für Spenden/Zuwendungsbelege,
 * deren Scan zu verstümmelt für deterministisches Text-Parsing ist (handschriftl.
 * Zahlscheine etc.). Rendert die Seiten und lässt das on-prem Multimodal-Modell
 * (gemma4-mm via vLLM) die tatsächlich GELEISTETEN Geldspenden auslesen; dedupli-
 * ziert (Empfänger+Datum+Betrag) und summiert → §10b (E0108701).
 *
 * KEINE Case-Werte, kein Mock — echtes Vision-Modell auf den echten Beleg.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const VLLM = process.env.KURATOR_URL ?? 'http://127.0.0.1:11435/v1/chat/completions';
const MODEL = process.env.KURATOR_MODEL ?? 'gemma4-mm';
const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface SpendenVision { betrag: number; posten: Array<{ empfaenger: string; betrag: number; datum?: string }>; }

export async function parseSpendenVision(path: string): Promise<SpendenVision | null> {
  const dir = mkdtempSync(join(tmpdir(), 'spv-'));
  try {
    execFileSync('pdftoppm', ['-png', '-r', '180', path, join(dir, 'p')], { stdio: 'pipe' });
    const pngs = readdirSync(dir).filter((f) => f.endsWith('.png')).sort().slice(0, 6);
    if (!pngs.length) return null;
    const images = pngs.map((f) => ({ type: 'image_url',
      image_url: { url: 'data:image/png;base64,' + readFileSync(join(dir, f)).toString('base64') } }));
    const prompt = 'Dies sind Seiten eines deutschen Spenden-/Zuwendungsbelegs (Zuwendungsbestätigungen '
      + 'und/oder SEPA-Überweisungsbelege). Extrahiere NUR tatsächlich GELEISTETE Geldspenden — jede '
      + 'Überweisung/Bestätigung GENAU EINMAL. Ignoriere handschriftliche Zusammenfassungen, geplante '
      + 'Beträge und Summenzeilen. Antworte als reines JSON: '
      + '{"spenden":[{"empfaenger":"…","betrag_eur":0.00,"datum":"YYYY-MM-DD"}]}';
    const body = JSON.stringify({ model: MODEL, max_tokens: 700, temperature: 0,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...images] }] });
    const r = await fetch(VLLM, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (!r.ok) return null;
    const j = await r.json() as { choices?: Array<{ message?: { content?: string } }> };
    const txt = j.choices?.[0]?.message?.content ?? '';
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as { spenden?: Array<{ empfaenger?: string; betrag_eur?: number; datum?: string }> };
    const raw = (parsed.spenden ?? []).filter((s) => s && typeof s.betrag_eur === 'number' && (s.betrag_eur ?? 0) > 0 && (s.betrag_eur ?? 0) < 100000);
    // Dedupe über Empfänger(kurz)+Datum+Betrag — dieselbe Zahlung erscheint oft
    // als Zahlschein UND Zuwendungsbestätigung.
    const seen = new Set<string>();
    const uniq: Array<{ empfaenger: string; betrag: number; datum?: string }> = [];
    for (const s of raw) {
      const key = `${String(s.empfaenger ?? '').toLowerCase().replace(/\s+/g, '').slice(0, 16)}|${s.datum ?? ''}|${s.betrag_eur}`;
      if (!seen.has(key)) { seen.add(key); uniq.push({ empfaenger: String(s.empfaenger ?? ''), betrag: Number(s.betrag_eur), datum: s.datum }); }
    }
    const betrag = round2(uniq.reduce((a, s) => a + s.betrag, 0));
    return betrag > 0 ? { betrag, posten: uniq } : null;
  } catch { return null; }
  finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
}
