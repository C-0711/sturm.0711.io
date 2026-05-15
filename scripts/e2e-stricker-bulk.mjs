#!/usr/bin/env node
/**
 * Vollständiger E2E mit allen Stricker-Fixtures gegen den Bulk-Upload.
 *
 * Was passiert:
 *   1. Neuer Steuerfall wird angelegt (POST /instances).
 *   2. Alle 7 Stricker-Fixtures werden in einer einzigen multipart-Request
 *      gegen /upload-bulk geschickt.
 *   3. Der SSE-Stream wird konsumiert; pro Dokument werden alle Events
 *      gesammelt (doc_start, stage_*, doc_done | doc_error).
 *   4. /aggregate wird gepollt (BMF Re-Compute über merged_layer).
 *   5. Pro Dokument wird der Run-Detail-Summary geladen.
 *   6. Ein detaillierter Markdown-Report wird geschrieben mit:
 *        - pro Doc: Stages-Tabelle + Fehler-Details
 *        - case-level: BMF-Werte, Konflikte, Coverage, Missing
 *        - Aufgelistete Fehler/Warnings über alle Docs hinweg.
 *
 * Aufruf:
 *   node scripts/e2e-stricker-bulk.mjs \
 *     --base https://sturm.0711.io \
 *     --fixtures ./tests/fixtures/stricker \
 *     --out reports/stricker-bulk-<ts>
 */
import { readFile, readdir, writeFile, mkdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

function parseArgs(argv) {
  const out = {
    base: 'https://sturm.0711.io',
    fixtures: path.join(REPO, 'tests/fixtures/stricker'),
    out: path.join(REPO, `reports/stricker-bulk-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`),
    waitMs: 360000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') out.base = argv[++i];
    else if (a === '--fixtures') out.fixtures = path.resolve(argv[++i]);
    else if (a === '--out') out.out = path.resolve(argv[++i]);
    else if (a === '--wait') out.waitMs = Number(argv[++i]);
  }
  return out;
}

function log(msg, payload) {
  const ts = new Date().toISOString().slice(11, 19);
  if (payload !== undefined) console.log(`[${ts}] ${msg}`, payload);
  else console.log(`[${ts}] ${msg}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });

  const findings = {
    startedAt: new Date().toISOString(),
    base: args.base,
    fixtures: args.fixtures,
    caseId: null,
    fileList: [],
    bulkEvents: [],
    perDoc: {},        // { filename: { runId, stages[], errors[], state } }
    aggregate: null,
    runSummaries: {},  // { runId: summary }
    httpErrors: [],
    warnings: [],
    timings: { start: Date.now() },
  };

  // 1. Fixtures inventarisieren
  log(`Loading fixtures from ${args.fixtures}`);
  const files = (await readdir(args.fixtures))
    .filter((f) => /\.(pdf|png|jpe?g)$/i.test(f))
    .sort();
  if (files.length === 0) { console.error('No fixtures'); process.exit(2); }
  for (const f of files) {
    const fp = path.join(args.fixtures, f);
    const s = await stat(fp);
    findings.fileList.push({ filename: f, size: s.size });
    log(`  · ${f} (${(s.size / 1024).toFixed(1)} KB)`);
  }

  // 2. Case anlegen
  log('Creating new case…');
  const createRes = await fetch(`${args.base}/api/applications/steuerfall-est/instances`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mandant_id: 'stricker-e2e',
      displayName: `Stricker E2E ${new Date().toISOString().slice(0, 19)}`,
      veranlagungsjahr: 2023,
    }),
  });
  if (!createRes.ok) {
    findings.httpErrors.push({ step: 'create', status: createRes.status, body: await createRes.text() });
    await writeReport(args.out, findings);
    process.exit(1);
  }
  const inst = await createRes.json();
  findings.caseId = inst.caseId;
  log(`Case created: ${inst.caseId}`);

  // 3. Bulk-Upload
  log(`Bulk uploading ${files.length} files…`);
  findings.timings.uploadStart = Date.now();
  const form = new FormData();
  for (const f of files) {
    const data = await readFile(path.join(args.fixtures, f));
    form.append('files', new Blob([data]), f);
  }

  const uploadRes = await fetch(
    `${args.base}/api/applications/steuerfall-est/instances/${encodeURIComponent(inst.caseId)}/upload-bulk?concurrency=3`,
    { method: 'POST', body: form },
  );
  if (!uploadRes.ok || !uploadRes.body) {
    findings.httpErrors.push({ step: 'upload-bulk', status: uploadRes.status, body: await uploadRes.text() });
    await writeReport(args.out, findings);
    process.exit(1);
  }

  // SSE-Stream konsumieren
  const reader = uploadRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let totalDocs = files.length;
  let docsDone = 0;
  let bulkDone = false;
  const deadline = Date.now() + args.waitMs;
  while (!bulkDone && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const p of parts) {
      const m = /^data:\s*(.+)$/m.exec(p);
      if (!m) continue;
      try {
        const ev = JSON.parse(m[1]);
        findings.bulkEvents.push(ev);
        const idx = ev.payload?.docIdx;
        const stageId = ev.stageId;
        if (ev.name === 'bulk_start') {
          totalDocs = ev.payload?.fileCount ?? totalDocs;
        }
        if (typeof idx === 'number') {
          const fname = files[idx];
          if (!findings.perDoc[fname]) {
            findings.perDoc[fname] = { idx, filename: fname, runId: ev.payload?.runId, stages: [], errors: [], state: 'running', startedAt: new Date().toISOString() };
          }
          const doc = findings.perDoc[fname];
          if (ev.name === 'doc_start') {
            doc.runId = ev.payload?.runId;
            doc.totalStages = ev.payload?.totalStages;
          }
          if (ev.name === 'stage_start' && stageId) {
            doc.stages.push({ id: stageId, startedAt: ev.at });
          }
          if (ev.name === 'stage_done' && stageId) {
            const s = doc.stages.find((x) => x.id === stageId);
            if (s) { s.finishedAt = ev.at; s.ms = ev.payload?.ms ?? null; s.state = 'ok'; }
          }
          if (ev.name === 'stage_error' && stageId) {
            doc.errors.push({ stage: stageId, error: ev.payload?.error || ev.payload });
            const s = doc.stages.find((x) => x.id === stageId);
            if (s) { s.finishedAt = ev.at; s.state = 'error'; s.error = ev.payload?.error; }
          }
          if (ev.name === 'doc_done') {
            doc.state = ev.payload?.state || 'ok';
            doc.fields = ev.payload?.fields ?? 0;
            doc.anlagen = ev.payload?.anlagen ?? [];
            doc.finishedAt = ev.at;
            docsDone++;
            log(`  ✓ ${fname}: ${doc.fields} Felder, Anlagen [${(doc.anlagen || []).join(',')}] (${docsDone}/${totalDocs})`);
          }
          if (ev.name === 'doc_error') {
            doc.state = 'error';
            doc.errors.push({ stage: null, error: ev.payload?.error });
            doc.finishedAt = ev.at;
            docsDone++;
            log(`  ✗ ${fname}: ${ev.payload?.error}`);
          }
        }
        if (ev.name === 'bulk_done') {
          bulkDone = true;
          findings.timings.uploadEnd = Date.now();
        }
      } catch (e) {
        findings.warnings.push({ at: 'sse-parse', msg: String(e?.message || e) });
      }
    }
  }
  log(`Bulk done in ${((findings.timings.uploadEnd - findings.timings.uploadStart) / 1000).toFixed(1)}s`);

  // 4. Aggregate
  log('Loading /aggregate…');
  const aggRes = await fetch(`${args.base}/api/applications/steuerfall-est/instances/${encodeURIComponent(inst.caseId)}/aggregate`);
  if (!aggRes.ok) {
    findings.httpErrors.push({ step: 'aggregate', status: aggRes.status, body: await aggRes.text() });
  } else {
    findings.aggregate = await aggRes.json();
    log(`  eCodes: ${findings.aggregate.stats.eCodes}, Konflikte: ${findings.aggregate.stats.conflicts}, Coverage: ${findings.aggregate.pflicht_coverage.covered}/${findings.aggregate.pflicht_coverage.total} (${findings.aggregate.pflicht_coverage.pct}%)`);
    if (findings.aggregate.bmf?.daten) {
      log(`  BMF: zvE=${findings.aggregate.bmf.daten.zve}, ESt=${findings.aggregate.bmf.daten.einkommensteuer}, Soli=${findings.aggregate.bmf.daten.solidaritaetszuschlag}, Gesamt=${findings.aggregate.bmf.daten.gesamtsteuer}`);
    }
  }

  // 5. Pro Doc den Run-Detail-Summary holen
  log('Loading per-doc run summaries…');
  for (const doc of Object.values(findings.perDoc)) {
    if (!doc.runId) continue;
    const r = await fetch(`${args.base}/api/applications/steuerfall-est/instances/${encodeURIComponent(inst.caseId)}/runs/${encodeURIComponent(doc.runId)}/summary`);
    if (r.ok) findings.runSummaries[doc.runId] = await r.json();
    else findings.warnings.push({ at: 'run-summary', runId: doc.runId, status: r.status });
  }

  // 6. Report schreiben
  findings.timings.end = Date.now();
  await writeReport(args.out, findings);

  const failedDocs = Object.values(findings.perDoc).filter((d) => d.state !== 'ok');
  console.log(`\n──────────────────────────────────────────────`);
  console.log(`Case:     ${findings.caseId}`);
  console.log(`Files:    ${findings.fileList.length}`);
  console.log(`Success:  ${Object.values(findings.perDoc).filter((d) => d.state === 'ok').length}`);
  console.log(`Failed:   ${failedDocs.length}`);
  if (findings.aggregate) {
    console.log(`eCodes:   ${findings.aggregate.stats.eCodes}`);
    console.log(`Conflicts: ${findings.aggregate.stats.conflicts}`);
    console.log(`Coverage: ${findings.aggregate.pflicht_coverage.pct}%`);
  }
  console.log(`Total:    ${((findings.timings.end - findings.timings.start) / 1000).toFixed(1)}s`);
  console.log(`Report:   ${path.join(args.out, 'report.md')}`);
  process.exit(failedDocs.length > 0 || findings.httpErrors.length > 0 ? 1 : 0);
}

async function writeReport(outDir, f) {
  await mkdir(outDir, { recursive: true });
  const md = [];
  md.push(`# Stricker Bulk E2E — Fehlerreport`);
  md.push('');
  md.push(`**Target:** ${f.base}`);
  md.push(`**Started:** ${f.startedAt}`);
  md.push(`**Case-ID:** \`${f.caseId ?? '(not created)'}\``);
  md.push(`**Fixtures:** ${f.fileList.length} Dateien`);
  if (f.timings.uploadEnd) {
    md.push(`**Bulk-Upload-Dauer:** ${((f.timings.uploadEnd - f.timings.uploadStart) / 1000).toFixed(1)}s`);
  }
  md.push('');

  // Datei-Inventar
  md.push(`## Eingabe-Dateien`);
  md.push('');
  md.push('| # | Datei | Größe |');
  md.push('|---|---|---|');
  for (let i = 0; i < f.fileList.length; i++) {
    const fi = f.fileList[i];
    md.push(`| ${i + 1} | \`${fi.filename}\` | ${(fi.size / 1024).toFixed(1)} KB |`);
  }
  md.push('');

  // Pro-Doc-Tabelle
  const docs = Object.values(f.perDoc).sort((a, b) => (a.idx ?? 0) - (b.idx ?? 0));
  const ok = docs.filter((d) => d.state === 'ok').length;
  const fail = docs.filter((d) => d.state !== 'ok').length;
  md.push(`## Per-Dokument-Status`);
  md.push('');
  md.push(`Erfolgreich: **${ok}** · Fehlgeschlagen: **${fail}**`);
  md.push('');
  md.push('| # | Datei | State | Felder | Anlagen | Run-ID | Dauer | Stage-Fehler |');
  md.push('|---|---|---|---|---|---|---|---|');
  for (const d of docs) {
    const dur = d.startedAt && d.finishedAt
      ? `${((new Date(d.finishedAt).getTime() - new Date(d.startedAt).getTime()) / 1000).toFixed(1)}s`
      : '—';
    const ico = d.state === 'ok' ? '✅' : '❌';
    md.push(`| ${d.idx ?? '?'} | \`${d.filename}\` | ${ico} ${d.state} | ${d.fields ?? 0} | ${(d.anlagen || []).join(', ') || '—'} | \`${d.runId ?? '(none)'}\` | ${dur} | ${d.errors.length} |`);
  }
  md.push('');

  // Aggregate
  if (f.aggregate) {
    md.push(`## Case-Level-Aggregat`);
    md.push('');
    const a = f.aggregate;
    md.push(`- **Dokumente:** ${a.stats.docs}`);
    md.push(`- **eCodes (merged):** ${a.stats.eCodes}`);
    md.push(`- **Konflikte:** ${a.stats.conflicts}`);
    md.push(`- **Pflicht-Coverage:** ${a.pflicht_coverage.covered}/${a.pflicht_coverage.total} (${a.pflicht_coverage.pct} %, measurable=${a.pflicht_coverage.measurable})`);
    md.push('');
    if (a.bmf?.daten) {
      md.push(`### BMF Lane-1 Berechnung`);
      md.push('');
      const eur = (cents) => cents == null ? '—' : new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(cents);
      md.push(`| Position | Wert |`);
      md.push(`|---|---|`);
      md.push(`| zu versteuerndes Einkommen | ${eur(a.bmf.daten.zve)} |`);
      md.push(`| tarifliche Einkommensteuer | ${eur(a.bmf.daten.einkommensteuer)} |`);
      md.push(`| Solidaritätszuschlag | ${eur(a.bmf.daten.solidaritaetszuschlag)} |`);
      md.push(`| festzusetzende Steuer | ${eur(a.bmf.daten.gesamtsteuer)} |`);
      if (a.bmf.daten.grenzsteuersatz != null) md.push(`| Grenzsteuersatz | ${(a.bmf.daten.grenzsteuersatz * 100).toFixed(2)} % |`);
      if (a.bmf.daten.durchschnittssteuersatz != null) md.push(`| ⌀-Steuersatz | ${(a.bmf.daten.durchschnittssteuersatz * 100).toFixed(2)} % |`);
      md.push('');
    } else if (a.bmf) {
      md.push(`### BMF Lane-1 nicht erfolgreich`);
      md.push('');
      md.push('```');
      md.push(JSON.stringify(a.bmf, null, 2));
      md.push('```');
      md.push('');
    }

    if (a.conflicts.length > 0) {
      md.push(`### Konflikte (${a.conflicts.length})`);
      md.push('');
      md.push('| eCode | Drucktext | Anlage | Kandidaten | Sieger |');
      md.push('|---|---|---|---|---|');
      for (const c of a.conflicts.slice(0, 50)) {
        const cands = c.candidates.map(cd => `\`${cd.value || '—'}\` (${cd.origin}, ${cd.sources.map(s => s.filename).join('+')})`).join('<br>');
        md.push(`| \`${c.eCode}\` | ${c.drucktext} | ${c.anlage} | ${cands} | \`${c.winner}\` |`);
      }
      md.push('');
    }

    if (a.pflicht_missing.length > 0) {
      md.push(`### Pflicht-Felder fehlend (${a.pflicht_missing.length})`);
      md.push('');
      md.push('| eCode | Drucktext | Anlage Z. | Suggestion |');
      md.push('|---|---|---|---|');
      for (const m of a.pflicht_missing.slice(0, 50)) {
        md.push(`| \`${m.eCode}\` | ${m.drucktext} | ${m.anlage} Z.${m.vordruckzeile} | ${(m.suggestedDocs || []).join(' · ') || '—'} |`);
      }
      md.push('');
    }
  }

  // Pro Doc: Stage-Detail
  md.push(`## Stage-Verlauf pro Dokument`);
  md.push('');
  for (const d of docs) {
    md.push(`### ${d.state === 'ok' ? '✅' : '❌'} ${d.filename}`);
    md.push('');
    md.push(`- Run-ID: \`${d.runId ?? '—'}\``);
    md.push(`- Felder extrahiert: **${d.fields ?? 0}**`);
    md.push(`- Anlagen erkannt: ${(d.anlagen || []).join(', ') || '—'}`);
    if (d.errors.length > 0) {
      md.push('');
      md.push('**Fehler:**');
      for (const e of d.errors) {
        md.push(`- ${e.stage ? `Stage \`${e.stage}\``: 'Run-Level'}: \`${typeof e.error === 'string' ? e.error.slice(0, 200) : JSON.stringify(e.error).slice(0, 200)}\``);
      }
    }
    md.push('');
    if (d.stages.length > 0) {
      md.push('| Stage | State | Dauer |');
      md.push('|---|---|---|');
      for (const s of d.stages) {
        const ico = s.state === 'ok' ? '✓' : s.state === 'error' ? '✗' : '…';
        md.push(`| \`${s.id}\` | ${ico} ${s.state ?? 'running'} | ${s.ms != null ? `${s.ms} ms` : '—'} |`);
      }
      md.push('');
    }
  }

  // HTTP-Fehler (falls vorhanden)
  if (f.httpErrors.length > 0) {
    md.push(`## HTTP-Fehler`);
    md.push('');
    md.push('```');
    for (const h of f.httpErrors) md.push(`${h.step}: HTTP ${h.status} — ${String(h.body).slice(0, 200)}`);
    md.push('```');
    md.push('');
  }

  // Warnings
  if (f.warnings.length > 0) {
    md.push(`## Warnings`);
    md.push('');
    md.push('```');
    for (const w of f.warnings) md.push(JSON.stringify(w));
    md.push('```');
    md.push('');
  }

  await writeFile(path.join(outDir, 'report.md'), md.join('\n'), 'utf-8');
  await writeFile(path.join(outDir, 'findings.json'), JSON.stringify(f, null, 2), 'utf-8');
}

main().catch((e) => { console.error('E2E aborted:', e); process.exit(2); });
