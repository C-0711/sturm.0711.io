#!/usr/bin/env -S npx tsx
import { readFileSync } from 'node:fs';
import { pruefeSoll, type RecoveryKind } from './soll-katalog.ts';
import { auditCase } from './audit.ts';
const data = JSON.parse(readFileSync(process.argv[2] ?? '/tmp/stricker-mastercase-input.json', 'utf8'));
const r = pruefeSoll(data);

const MARK: Record<RecoveryKind, string> = {
  erfuellt: '✓ erfüllt   ', im_beleg: '▸ aus BELEG ', berechenbar: '▸ BERECHNET ', vorjahr: '▸ aus VORJAHR', fehlt: '✗ FRAGEN    ',
};
console.log(`\nSOLL-LISTE mit Recovery-Regel · Profil: ${r.profile.join(', ')}`);
console.log(`Abdeckung: ${r.abdeckung.erfuellt} erfüllt · ${r.abdeckung.recoverbar} recoverbar · ${r.abdeckung.fehlt} echt fehlend  (von ${r.abdeckung.gesamt})\n`);
for (const e of r.ergebnisse) {
  console.log(`  ${MARK[e.status]} [${e.item.severity.padEnd(9)}] ${e.item.label.padEnd(42)}`);
  if (e.status !== 'erfuellt') console.log(`               ↳ ${e.hinweis}`);
}

const rep = auditCase(data);
const soll = rep.findings.filter((f) => f.basis.ref.startsWith('soll:'));
console.log(`\n── auditCase(): ${rep.findings.length} Befunde · ${soll.length} aus Soll-Liste ──`);
for (const f of soll) console.log(`   [${f.severity.padEnd(9)}] ${f.kind.padEnd(13)} ${f.basis.ref.replace('soll:', '').padEnd(13)} ${(f.frage ?? '').slice(0, 60)}`);
