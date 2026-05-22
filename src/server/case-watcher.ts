// case-watcher.ts — Filesystem-Watcher auf applications-data/steuerfall-est/<caseId>.json
//
// Anstatt jeden Stage zu patchen, beobachten wir die ground-truth (das Case-
// JSON wird vom STURM-Runner nach jedem Stage geupdatet) und diff'en gegen
// den vorigen Stand → daraus rekonstruieren wir saubere CaseEvents.
//
// Robust auch bei zukünftigen Pipeline-Änderungen — solange Stages ins
// gleiche JSON-File schreiben, fließen Events automatisch durch.

import { watch, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { caseEvents, type CaseEvent } from './case-events.ts';
import { narratorTick } from './case-narrator.ts';

const APP_DATA_DIR = process.env.APPLICATIONS_DATA_DIR
  || join(process.cwd(), 'applications-data', 'steuerfall-est');

// Pro caseId: zuletzt gelesener Stand (für Diff) + WatchController
const lastSnapshot = new Map<string, any>();
const watchers = new Map<string, AbortController>();
// Track if narrator-tick has been scheduled
const narratorTimers = new Map<string, NodeJS.Timeout>();

function debouncedNarrate(caseId: string) {
  const existing = narratorTimers.get(caseId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    narratorTimers.delete(caseId);
    void narratorTick(caseId).catch(e => {
      caseEvents.emit(caseId, { kind: 'narrator.error', message: String(e?.message ?? e) });
    });
  }, 800);  // 800ms debounce: warten ob noch mehr events kommen
  narratorTimers.set(caseId, t);
}

function diffAndEmit(caseId: string, oldState: any, newState: any): void {
  // Document-level diff: erkennt neu hinzugefügte Belege und State-Wechsel.
  const oldDocs = new Map<string, any>(
    (oldState?.documents ?? []).map((d: any) => [d.runId || d.doc_id || d.filename, d])
  );
  const newDocs = (newState?.documents ?? []) as any[];

  for (const d of newDocs) {
    const key = d.runId || d.doc_id || d.filename;
    const before = oldDocs.get(key);

    if (!before) {
      // Neuer Beleg eingelaufen
      caseEvents.emit(caseId, {
        kind: 'beleg.uploaded',
        doc_id: key,
        filename: d.filename,
      });
      if (d.indikation?.belegtyp) {
        caseEvents.emit(caseId, {
          kind: 'beleg.classified',
          doc_id: key,
          belegtyp: d.indikation.belegtyp,
          anlagen: d.indikation.anlagen,
        });
      }
      // Werte als value.extracted
      const werte = d.indikation?.wichtige_werte;
      if (Array.isArray(werte)) {
        for (const w of werte) {
          caseEvents.emit(caseId, {
            kind: 'value.extracted',
            doc_id: key,
            label: String(w.label || ''),
            value: String(w.value || ''),
          });
        }
      }
      continue;
    }

    // Bestehender Beleg: indikation neu oder Werte ergänzt?
    if (!before.indikation && d.indikation) {
      caseEvents.emit(caseId, {
        kind: 'beleg.classified',
        doc_id: key,
        belegtyp: d.indikation.belegtyp,
        anlagen: d.indikation.anlagen,
      });
      const werte = d.indikation.wichtige_werte;
      if (Array.isArray(werte)) {
        for (const w of werte) {
          caseEvents.emit(caseId, {
            kind: 'value.extracted',
            doc_id: key, label: String(w.label || ''), value: String(w.value || ''),
          });
        }
      }
    } else if (before.indikation && d.indikation) {
      // diff in werte
      const beforeKeys = new Set((before.indikation.wichtige_werte || []).map((w: any) => w.label + '|' + w.value));
      for (const w of (d.indikation.wichtige_werte || [])) {
        const k = w.label + '|' + w.value;
        if (!beforeKeys.has(k)) {
          caseEvents.emit(caseId, {
            kind: 'value.extracted',
            doc_id: key, label: String(w.label || ''), value: String(w.value || ''),
          });
        }
      }
    }

    // pages.length diff
    const beforePages = (before.pages || []).length;
    const nowPages = (d.pages || []).length;
    for (let p = beforePages; p < nowPages; p++) {
      caseEvents.emit(caseId, {
        kind: 'page.read',
        doc_id: key,
        page: p + 1,
        totalPages: d.pages?.length || nowPages,
      });
    }

    // status diff
    if (before.state !== d.state && d.state) {
      caseEvents.emit(caseId, {
        kind: 'beleg.state_change',
        doc_id: key,
        status: d.state === 'ok' ? 'done' : (d.state === 'error' ? 'error' : 'start'),
      });
    }
  }

  // Berechnung diff
  const oldBer = oldState?.berechnung ?? oldState?.fall_daten?.berechnung;
  const newBer = newState?.berechnung ?? newState?.fall_daten?.berechnung;
  if (!oldBer && newBer) {
    const erg = newBer.ergebnis || newBer;
    caseEvents.emit(caseId, {
      kind: 'berechnung.lane1',
      ms: Number(newBer.dauer_ms ?? 0),
      data: { zve: erg.zve, est: erg.einkommensteuer, erstattung: erg.erstattung_oder_nachzahlung },
    });
  }
}

export function startCaseWatcher(caseId: string): void {
  if (watchers.has(caseId)) return;  // schon gewatcht
  const file = join(APP_DATA_DIR, `${caseId}.json`);
  if (!existsSync(file)) return;

  const ctl = new AbortController();
  watchers.set(caseId, ctl);

  (async () => {
    try {
      // Initial-State laden + initial-replay
      try {
        const txt = await readFile(file, 'utf8');
        const state = JSON.parse(txt);
        lastSnapshot.set(caseId, state);
      } catch {}

      const w = watch(file, { signal: ctl.signal });
      for await (const _ev of w) {
        try {
          await new Promise(r => setTimeout(r, 80));  // settle
          const txt = await readFile(file, 'utf8');
          const newState = JSON.parse(txt);
          const old = lastSnapshot.get(caseId);
          if (old) diffAndEmit(caseId, old, newState);
          lastSnapshot.set(caseId, newState);
          debouncedNarrate(caseId);
        } catch (e: any) {
          // file mid-write or invalid json → ignore, next event will retry
        }
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        console.warn(`[case-watcher] ${caseId}:`, e?.message ?? e);
      }
    }
  })();
}

export function stopCaseWatcher(caseId: string): void {
  const ctl = watchers.get(caseId);
  if (ctl) { ctl.abort(); watchers.delete(caseId); }
}

export function getCaseSnapshot(caseId: string): any | null {
  return lastSnapshot.get(caseId) ?? null;
}
