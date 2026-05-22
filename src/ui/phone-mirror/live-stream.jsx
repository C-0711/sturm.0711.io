// live-stream.jsx — Phone-Live-View: 1 Beleg auf einmal, Storytelling-Modus.
//
// Quelle: case-state.documents (synced via window.__caseState + caseStateUpdated).
// Layout: pro Beleg eine große Karte mit Hauptwert, Belegtyp, Anlagen-Chips.
// Verhalten:
//   - wird gerade gelesen → sofort Fokus
//   - alle fertig        → Auto-Rotation alle 4s
//   - neuer kommt rein   → spring sofort darauf (überschreibt Auto-Rotate)
//
// Narrator: lokaler Coach-Template, optional überschrieben vom Haiku-SSE.

(function () {
  const F = window.CtaxFonts || {
    display: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", "Inter", sans-serif',
    sans:    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Inter", sans-serif',
    mono:    '"Geist Mono", "JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace',
  };
  const C = window.CtaxTokens || {
    bg0: '#08080c', bg1: '#14181f', bg2: '#1e242e',
    line: 'rgba(255,255,255,0.08)',
    fg: '#fbfaf7', fgMuted: '#7a8294', fgDim: '#4a5260',
    iris: '#7a9cd8', irisHi: '#a8c0e8', irisDim: 'rgba(122,156,216,0.18)',
    gold: '#e8c878', goldDim: 'rgba(232,200,120,0.18)',
    ok: '#7ac0a4', warn: '#e89070',
  };

  const AUTO_MS = 4200;

  function shortFilename(fn) {
    if (!fn) return '';
    const base = String(fn).replace(/^.*[\\/]/, '');
    if (base.length <= 32) return base;
    return base.slice(0, 14) + '…' + base.slice(-14);
  }

  function docKey(d) { return d?.runId || d?.doc_id || d?.filename || 'unk'; }

  function docStatus(d) {
    if (d?.state === 'error') return 'fehler';
    if (d?.state === 'ok' || (d?.indikation?.wichtige_werte?.length ?? 0) > 0) return 'fertig';
    return 'liest';
  }

  function statusColor(s) {
    return s === 'fertig' ? C.ok : s === 'fehler' ? C.warn : C.gold;
  }

  function topValue(d) {
    const w = d?.indikation?.wichtige_werte;
    if (!Array.isArray(w) || w.length === 0) return null;
    const priority = ['bruttoarbeitslohn', 'betrag', 'kapitalerträge', 'kapitalertrag', 'rentenbetrag', 'einbehaltene lohnsteuer'];
    for (const p of priority) {
      const hit = w.find(x => String(x.label || '').toLowerCase().includes(p));
      if (hit) return hit;
    }
    return w.find(x => /\d/.test(String(x.value || ''))) || w[0];
  }

  function useTypewriter(target, charsPerSec = 55) {
    const [shown, setShown] = React.useState(target || '');
    const reqRef = React.useRef(0);
    React.useEffect(() => {
      if (!target) { setShown(''); return; }
      const start = performance.now();
      const total = target.length;
      const dur = Math.max(400, (total / charsPerSec) * 1000);
      const tick = (now) => {
        const t = Math.min(1, (now - start) / dur);
        setShown(target.slice(0, Math.floor(total * t)));
        if (t < 1) reqRef.current = requestAnimationFrame(tick);
        else setShown(target);
      };
      reqRef.current = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(reqRef.current);
    }, [target, charsPerSec]);
    return shown;
  }

  function localCoach(d) {
    if (!d) return '';
    const s = docStatus(d);
    if (s === 'liest') return `Lese ${d.indikation?.belegtyp || 'diesen Beleg'}…`;
    if (s === 'fehler') return 'Beleg konnte nicht gelesen werden — wir versuchen es gleich nochmal.';
    const top = topValue(d);
    const typ = (d.indikation?.belegtyp || 'Beleg').toLowerCase();
    if (!top) return `${d.indikation?.belegtyp} verarbeitet — keine Werte erkannt.`;
    const v = String(top.value || '');
    if (/lohn/.test(typ)) return `${v} Lohn aufgenommen — wird gegen deine Vorauszahlung verrechnet.`;
    if (/spende/.test(typ)) return `${v} Spende — Sonderausgaben, voll absetzbar bis 20% deiner Einkünfte.`;
    if (/handwerker|haushaltsnahe|renov/.test(typ)) return `${v} — 20% Steuerermäßigung nach §35a EStG.`;
    if (/schornstein/.test(typ)) return `${v} Schornsteinfeger — komplett als haushaltsnahe Leistung anrechenbar.`;
    if (/heizung|kamin|wartung/.test(typ)) return `${v} — Handwerkerleistung, 20% direkt von der Steuer ab.`;
    if (/kapital|zins/.test(typ)) return `${v} Kapitalertrag — bei Sparer-Pauschbetrag oft komplett steuerfrei.`;
    if (/renten/.test(typ)) return `${v} Rente — wird teilweise besteuert je nach Renteneintrittsjahr.`;
    if (/kranken|pflege|vorsorge/.test(typ)) return `${v} Vorsorgebeitrag — voll absetzbar nach §10 EStG.`;
    return `${v} — gespeichert, fließt in die Berechnung.`;
  }

  function StatsHeader({ caseState, current, total }) {
    const docs = caseState?.documents || [];
    const fertig = docs.filter(d => docStatus(d) === 'fertig').length;
    const fehler = docs.filter(d => docStatus(d) === 'fehler').length;
    const liest = docs.length - fertig - fehler;
    return React.createElement('div', { style: { padding: '70px 16px 4px' } },
      React.createElement('div', {
        style: {
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          marginBottom: 8,
        }
      },
        React.createElement('div', { style: { fontFamily: F.mono, fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.fgDim } }, 'LIVE · ' + (caseState?.displayName || 'Fall')),
        React.createElement('div', { style: { display: 'flex', gap: 6, fontSize: 10, fontFamily: F.mono } },
          React.createElement('span', { style: { color: C.ok } }, '✓ ' + fertig),
          liest > 0 && React.createElement('span', { style: { color: C.gold } }, '⏳ ' + liest),
          fehler > 0 && React.createElement('span', { style: { color: C.warn } }, '⚠ ' + fehler),
        ),
      ),
      // Progress dots
      total > 0 && React.createElement('div', { style: { display: 'flex', gap: 3 } },
        Array.from({ length: total }).map((_, i) =>
          React.createElement('div', {
            key: i,
            style: {
              flex: 1, height: 2, borderRadius: 1,
              background: i === current ? C.iris : (i < current ? C.iris : C.line),
              opacity: i === current ? 1 : (i < current ? 0.5 : 0.25),
              transition: 'all 300ms ease',
            }
          })
        )
      )
    );
  }

  function DocFocusCard({ d }) {
    if (!d) return null;
    const status = docStatus(d);
    const color = statusColor(status);
    const top = topValue(d);
    const anl = (d.indikation?.anlagen || []).slice(0, 3);
    const typ = d.indikation?.belegtyp || 'Beleg';

    return React.createElement('div', {
      key: docKey(d),  // re-mount on change → triggers animations
      style: {
        position: 'absolute', top: 110, left: 0, right: 0,
        padding: '12px 24px',
        animation: 'liveFocusIn 480ms cubic-bezier(0.34, 1.56, 0.64, 1) both',
      }
    },
      // Status-Pille oben
      React.createElement('div', {
        style: {
          display: 'inline-block',
          fontSize: 9, fontFamily: F.mono, letterSpacing: '0.16em', textTransform: 'uppercase',
          padding: '2px 8px', borderRadius: 999,
          background: color + '22', color: color,
          marginBottom: 16,
        }
      }, status),

      // Belegtyp groß
      React.createElement('div', {
        style: {
          fontFamily: F.display, fontSize: 22, fontWeight: 600, color: C.fg, lineHeight: 1.15,
          marginBottom: 6,
        }
      }, typ),

      // Aussteller / Empfänger (klein)
      React.createElement('div', {
        style: { fontSize: 11, color: C.fgMuted, marginBottom: 18 }
      }, shortFilename(d.filename || '')),

      // Hauptwert (riesig)
      top && React.createElement('div', { style: { marginBottom: 14 } },
        React.createElement('div', {
          style: { fontSize: 10, color: C.fgDim, fontFamily: F.mono, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }
        }, top.label),
        React.createElement('div', {
          style: {
            fontFamily: F.mono, fontSize: 36, fontWeight: 500, color: C.gold,
            fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em', lineHeight: 1,
          }
        }, top.value),
      ),

      // Anlagen-Chips
      anl.length > 0 && React.createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 } },
        anl.map((a, i) => React.createElement('span', {
          key: i,
          style: {
            fontSize: 10, padding: '3px 8px', borderRadius: 999,
            background: C.irisDim, color: C.irisHi, fontFamily: F.mono, fontWeight: 500,
            animation: `liveChipPop 320ms ${i * 80 + 200}ms both`,
          }
        }, a))
      ),
    );
  }

  // ─── Live-Ticker ──────────────────────────────────────────────────────────
  // Während Belege noch laufen: einzelne Infos (Belegtyp/Wert/Anlage) gleiten
  // nacheinander ein — wie ein Börsen-Ticker. Eine Zeile = ein Atomic-Fact.

  function isJunkBelegtyp(t) {
    if (!t) return true;
    const s = String(t).toLowerCase().trim();
    return /^(unbekannt(es)?(\s+dokument)?|sonstiges|unknown|\?)$/i.test(s) || s.length < 3;
  }

  function isJunkValue(v) {
    if (v == null) return true;
    const s = String(v).trim();
    if (s.length === 0) return true;
    if (s.length > 80) return true;  // OCR-Müll wie "Die bereitgestellte Bilddatei…"
    if (/leere\s+tabellen|keine\s+texte|enthält\s+keine/i.test(s)) return true;
    return false;
  }

  function extractAtoms(docs) {
    // Atomic-Facts pro Beleg in chronologischer Reihenfolge.
    // Filter: kein "Unbekanntes Dokument", keine OCR-Müll-Strings,
    // bei Fehlern zeigen wir ⚠ statt scheinbarem Erfolg.
    const atoms = [];
    const sortedDocs = [...docs].sort((a, b) => (a.uploadedAt || '').localeCompare(b.uploadedAt || ''));
    for (const d of sortedDocs) {
      const key = docKey(d);
      const status = docStatus(d);
      const hasGoodTyp = !isJunkBelegtyp(d.indikation?.belegtyp);
      const validWerte = (d.indikation?.wichtige_werte || []).filter(w =>
        !isJunkValue(w.value) && !isJunkValue(w.label)
      );
      const anlagen = d.indikation?.anlagen || [];

      // Junk-Beleg (Mistral konnte nichts extrahieren): nur 1 Warn-Zeile, sonst nichts
      if (status === 'fertig' && !hasGoodTyp && validWerte.length === 0 && anlagen.length === 0) {
        atoms.push({
          kind: 'leer', key: key + ':l', doc: d,
          text: shortFilename(d.filename || '') + ' — keine Daten erkannt',
          color: C.warn,
        });
        continue;
      }

      // Echter Fehler
      if (status === 'fehler') {
        atoms.push({
          kind: 'fehler', key: key + ':e', doc: d,
          text: shortFilename(d.filename || '') + ' — Lesefehler',
          color: C.warn,
        });
        continue;
      }

      // Wenn noch wird gelesen + noch kein Belegtyp: 1 zarte upload-Zeile
      if (status === 'liest' && !hasGoodTyp) {
        atoms.push({
          kind: 'upload', key: key + ':u', doc: d,
          text: shortFilename(d.filename || ''),
          color: C.fgDim,
        });
        continue;
      }

      // Belegtyp wenn brauchbar
      if (hasGoodTyp) {
        atoms.push({ kind: 'typ', key: key + ':t', doc: d, text: d.indikation.belegtyp, color: C.fg });
      }
      // Werte
      for (const w of validWerte) {
        atoms.push({
          kind: 'wert',
          key: key + ':w:' + (w.label || '?'),
          doc: d, label: w.label, text: w.value,
          color: /\d/.test(String(w.value || '')) ? C.gold : C.fgMuted,
        });
      }
      // Anlagen
      for (const a of anlagen) {
        atoms.push({ kind: 'anlage', key: key + ':a:' + a, doc: d, text: a, color: C.irisHi });
      }
    }
    return atoms;
  }

  function LiveTicker({ caseState }) {
    const atoms = React.useMemo(() => extractAtoms(caseState?.documents || []), [caseState]);
    const scrollRef = React.useRef(null);
    const prevLenRef = React.useRef(0);
    const [newKeys, setNewKeys] = React.useState(new Set());

    React.useEffect(() => {
      const prevLen = prevLenRef.current;
      if (atoms.length > prevLen) {
        const fresh = new Set(atoms.slice(prevLen).map(a => a.key));
        setNewKeys(fresh);
        setTimeout(() => setNewKeys(new Set()), 900);
      }
      prevLenRef.current = atoms.length;
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }, [atoms.length]);

    return React.createElement('div', {
      ref: scrollRef,
      style: {
        position: 'absolute', top: 110, left: 0, right: 0, bottom: 180,
        overflowY: 'auto', padding: '0 18px',
        maskImage: 'linear-gradient(to bottom, transparent 0, #000 6%, #000 90%, transparent 100%)',
        WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, #000 6%, #000 90%, transparent 100%)',
      }
    },
      atoms.slice(-30).map((a) =>
        React.createElement('div', {
          key: a.key,
          style: {
            display: 'flex', alignItems: 'baseline', gap: 8,
            padding: '3px 0',
            opacity: 0,
            animation: 'liveAtomIn 360ms ease-out forwards',
            borderBottom: `1px solid ${C.line}`,
          }
        },
          React.createElement('span', {
            style: { fontFamily: F.mono, fontSize: 8, color: C.fgDim, width: 50, flexShrink: 0, textTransform: 'uppercase', letterSpacing: '0.06em' }
          }, a.kind === 'wert' ? (a.label || '').slice(0, 8) : a.kind),
          React.createElement('span', {
            style: {
              fontFamily: a.kind === 'wert' || a.kind === 'anlage' ? F.mono : F.sans,
              fontSize: a.kind === 'wert' && /\d/.test(String(a.text)) ? 13 : 11,
              color: a.color, flex: 1,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }
          }, a.text)
        )
      )
    );
  }

  // ─── Klärungs-Modus ──────────────────────────────────────────────────────
  // Nach Pipeline-Ende: fragt aktiv die Posten ab, die im Vorjahr deklariert
  // waren, aber für dieses Jahr noch keinen Beleg haben.
  //
  // Datenquelle ideal: caseState.vorjahres_kontext.ecodes — Map ecode→wert.
  // Solange das noch nicht da ist: heuristische Patterns aus erkannten Anlagen
  // im Vorjahres-Beleg.

  function findVorjahrDoc(docs) {
    return docs.find(d => {
      const t = (d.indikation?.belegtyp || '').toLowerCase();
      return /einkommensteuererklärung|einkommensteuerbescheid|steuerbescheid|elster.*dokument/i.test(t);
    });
  }

  function buildKlaerungsFragen(caseState) {
    const docs = caseState?.documents || [];
    const vorjahr = findVorjahrDoc(docs);
    if (!vorjahr) return [];
    const vorjahrAnlagen = new Set(vorjahr.indikation?.anlagen || []);
    const vorjahrWerte = vorjahr.indikation?.wichtige_werte || [];

    // Erkennen welche Anlagen aktuell noch keinen eigenen Beleg haben
    const aktuelleBelegtypen = docs
      .filter(d => d !== vorjahr)
      .map(d => (d.indikation?.belegtyp || '').toLowerCase())
      .join(' | ');

    const fragen = [];

    // ── Stammdaten: Adresse + Bankverbindung ─────────────────────────────
    fragen.push({
      id: 'adresse',
      kicker: 'Stammdaten',
      headline: 'Adresse noch gleich?',
      sub: 'Wohnsitz, Telefonnummer, Mailadresse — alles unverändert seit letztem Jahr?',
      vorjahresInfo: vorjahrWerte.find(w => /adresse|straße|wohn/i.test(w.label || ''))?.value || 'wie im Vorjahr',
      antworten: ['Alles gleich', 'Etwas hat sich geändert'],
    });

    // ── Pendlerpauschale wenn N im Vorjahr aber kein KM-Beleg ────────────
    if (vorjahrAnlagen.has('N') && !/pendler|km|fahrt/i.test(aktuelleBelegtypen)) {
      fragen.push({
        id: 'pendler',
        kicker: 'Werbungskosten',
        headline: 'Pendelst du zur gleichen Arbeit?',
        sub: 'Im Vorjahr hattest du eine Wegstrecke angegeben. Gleicher Job, gleicher Weg?',
        vorjahresInfo: 'Vorjahres-Pendlerpauschale',
        antworten: ['Ja, gleich', 'Anderer Job', 'Anderer Wohnort'],
      });
    }

    // ── Spenden wenn SA im Vorjahr ───────────────────────────────────────
    if (vorjahrAnlagen.has('SA') && !/spende/i.test(aktuelleBelegtypen)) {
      fragen.push({
        id: 'spenden',
        kicker: 'Sonderausgaben',
        headline: 'Spenden 2024?',
        sub: 'Letztes Jahr hattest du Spenden angegeben. Gab es 2024 wieder welche?',
        vorjahresInfo: vorjahrWerte.find(w => /spende/i.test(w.label || ''))?.value || 'Spenden im Vorjahr',
        antworten: ['Ja, Belege folgen', 'Nein, keine Spenden 2024', 'Wie letztes Jahr'],
      });
    }

    // ── Krankheitskosten / agB ───────────────────────────────────────────
    if (vorjahrAnlagen.has('AGB') || vorjahrAnlagen.has('AV')) {
      fragen.push({
        id: 'krankheit',
        kicker: 'Außergewöhnliche Belastungen',
        headline: 'Größere Krankheitskosten 2024?',
        sub: 'Arztrechnungen, Zahnersatz, Brille, Medikamente außerhalb der Krankenkasse?',
        vorjahresInfo: 'Im Vorjahr deklariert',
        antworten: ['Nein, nichts', 'Ja, ich reiche nach', 'Vielleicht — prüfen'],
      });
    }

    // ── Haushaltsnahe / Handwerker — bei vielen HA_35a-Belegen schon klar
    if (vorjahrAnlagen.has('HA_35a') && !/handwerk|haushalt|schornstein|wartung|renov/i.test(aktuelleBelegtypen)) {
      fragen.push({
        id: 'haushaltsnah',
        kicker: 'Haushaltsnahe (§35a)',
        headline: 'Handwerker oder Hausreinigung 2024?',
        sub: 'Schornsteinfeger, Gartenpflege, Reinigung, Heizungswartung — alles was im Haushalt anfällt.',
        vorjahresInfo: 'Vorjahres-Posten',
        antworten: ['Ja, sammle ich noch', 'Nein, nichts dieses Jahr', 'Wie letztes Jahr'],
      });
    }

    // ── Bankverbindung ───────────────────────────────────────────────────
    fragen.push({
      id: 'bank',
      kicker: 'Erstattung',
      headline: 'Bankverbindung gleich?',
      sub: 'Falls Erstattung rauskommt — auf das gleiche Konto wie letztes Jahr?',
      vorjahresInfo: 'IBAN aus Vorjahres-Bescheid',
      antworten: ['Ja, gleich', 'Neues Konto'],
    });

    // ── Familienstand (immer fragen, schnell beantwortet) ────────────────
    fragen.push({
      id: 'familie',
      kicker: 'Veranlagung',
      headline: 'Familienstand unverändert?',
      sub: 'Verheiratet/eingetragen, Kinder, Pflegeperson — irgendwas Neues 2024?',
      vorjahresInfo: 'wie im Vorjahr',
      antworten: ['Alles gleich', 'Was Neues'],
    });

    return fragen;
  }

  function ClaerungsCard({ frage, idx, total, onAntwort }) {
    return React.createElement('div', {
      key: frage.id,
      style: {
        position: 'absolute', top: 110, left: 0, right: 0, bottom: 80,
        padding: '12px 24px',
        animation: 'liveFocusIn 480ms cubic-bezier(0.34, 1.56, 0.64, 1) both',
        display: 'flex', flexDirection: 'column',
      }
    },
      React.createElement('div', {
        style: { fontFamily: F.mono, fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.iris, marginBottom: 12 }
      }, `${frage.kicker} · Frage ${idx + 1}/${total}`),

      React.createElement('div', {
        style: { fontFamily: F.display, fontSize: 22, fontWeight: 600, color: C.fg, lineHeight: 1.2, marginBottom: 8 }
      }, frage.headline),

      React.createElement('div', {
        style: { fontSize: 12, color: C.fgMuted, lineHeight: 1.45, marginBottom: 14 }
      }, frage.sub),

      // Vorjahres-Info-Pille
      React.createElement('div', {
        style: {
          fontSize: 10, fontFamily: F.mono, color: C.gold,
          padding: '6px 10px', background: C.goldDim, borderRadius: 6,
          marginBottom: 18, display: 'inline-block',
        }
      }, '📂 ' + frage.vorjahresInfo),

      // Antwort-Buttons
      React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        frage.antworten.map((a, i) =>
          React.createElement('button', {
            key: i,
            onClick: (e) => { e.stopPropagation(); onAntwort(frage.id, a); },
            style: {
              padding: '11px 14px', borderRadius: 999,
              border: `1px solid ${C.line}`,
              background: i === 0 ? `linear-gradient(135deg, ${C.iris} 0%, ${C.irisHi} 100%)` : 'transparent',
              color: i === 0 ? '#fff' : C.fg,
              fontSize: 13, fontFamily: F.sans, fontWeight: 500,
              cursor: 'pointer', textAlign: 'left',
              animation: `liveChipPop 320ms ${i * 70 + 300}ms both`,
            }
          }, a)
        )
      )
    );
  }

  function ClaerungsModus({ caseState }) {
    const fragen = React.useMemo(() => buildKlaerungsFragen(caseState), [caseState]);
    const [idx, setIdx] = React.useState(0);
    const [antworten, setAntworten] = React.useState({});

    const onAntwort = (id, antwort) => {
      setAntworten(prev => ({ ...prev, [id]: antwort }));
      setTimeout(() => setIdx(i => Math.min(fragen.length, i + 1)), 280);
    };

    if (fragen.length === 0) {
      return React.createElement('div', {
        style: { position: 'absolute', top: 110, left: 0, right: 0, padding: 24, color: C.fgMuted, fontSize: 12, fontFamily: F.mono, textAlign: 'center' }
      }, 'Keine Vorjahres-Klärungen nötig.');
    }
    if (idx >= fragen.length) {
      // Alle beantwortet — Bereit-Karte
      return React.createElement('div', {
        style: {
          position: 'absolute', top: 110, left: 0, right: 0, bottom: 80,
          padding: '12px 24px', display: 'flex', flexDirection: 'column', justifyContent: 'center',
        }
      },
        React.createElement('div', {
          style: { fontFamily: F.mono, fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.ok, marginBottom: 12 }
        }, '✓ Klärung fertig'),
        React.createElement('div', {
          style: { fontFamily: F.display, fontSize: 26, fontWeight: 600, color: C.fg, lineHeight: 1.15, marginBottom: 12 }
        }, 'Bereit zur Berechnung.'),
        React.createElement('div', {
          style: { fontSize: 12, color: C.fgMuted, lineHeight: 1.5, marginBottom: 22 }
        }, `${Object.keys(antworten).length} Fragen beantwortet · alle Belege gelesen · ich kann jetzt deine Steuer berechnen.`),
        React.createElement('button', {
          style: {
            padding: '14px 18px', borderRadius: 999, border: 'none',
            background: `linear-gradient(135deg, ${C.ok} 0%, ${C.iris} 100%)`,
            color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
            fontFamily: F.sans,
          }
        }, 'Jetzt berechnen')
      );
    }
    return React.createElement(ClaerungsCard, { frage: fragen[idx], idx, total: fragen.length, onAntwort });
  }

  function LiveStream({ caseState }) {
    const docs = (caseState?.documents || []);
    const [idx, setIdx] = React.useState(0);
    const prevDocsRef = React.useRef([]);
    const allFertig = docs.length > 0 && docs.every(d => docStatus(d) === 'fertig' || docStatus(d) === 'fehler');
    const hasVorjahr = !!findVorjahrDoc(docs);

    // Sortier-Strategie: laufende zuerst (in Eingangsreihenfolge), dann fertige.
    const sorted = React.useMemo(() => {
      const a = [...docs];
      a.sort((x, y) => {
        const sx = docStatus(x), sy = docStatus(y);
        if (sx === sy) return 0;
        if (sx === 'liest') return -1;
        if (sy === 'liest') return 1;
        if (sx === 'fehler') return 1;
        if (sy === 'fehler') return -1;
        return 0;
      });
      return a;
    }, [docs]);

    // Diff: wenn neuer Beleg dazu kommt → springe drauf
    React.useEffect(() => {
      const prevKeys = new Set(prevDocsRef.current.map(docKey));
      const newOnes = sorted.findIndex(d => !prevKeys.has(docKey(d)));
      if (newOnes >= 0) {
        setIdx(newOnes);
      } else if (idx >= sorted.length) {
        setIdx(Math.max(0, sorted.length - 1));
      }
      prevDocsRef.current = sorted;
    }, [sorted.length, sorted.map(docKey).join(',')]);

    // Auto-Rotation — pausiert wenn aktuell sichtbares Doc gerade noch liest
    React.useEffect(() => {
      if (sorted.length <= 1) return;
      const cur = sorted[idx];
      if (cur && docStatus(cur) === 'liest') return;  // bleibt drauf
      const t = setTimeout(() => setIdx(i => (i + 1) % sorted.length), AUTO_MS);
      return () => clearTimeout(t);
    }, [idx, sorted.length, sorted[idx] && docStatus(sorted[idx])]);

    const current = sorted[idx];
    const coachTxt = React.useMemo(() => {
      if (window.__narratorText && Date.now() - (window.__narratorTs || 0) < 30000) return window.__narratorText;
      return localCoach(current);
    }, [current, caseState]);
    const typed = useTypewriter(coachTxt, 55);

    return React.createElement('div', {
      style: {
        position: 'absolute', inset: 0,
        background: `radial-gradient(140% 70% at 50% -10%, ${C.iris}1c 0%, transparent 55%), linear-gradient(180deg, ${C.bg0} 0%, ${C.bg1} 100%)`,
        overflow: 'hidden', fontFamily: F.sans, color: C.fg,
      },
      onClick: () => allFertig && sorted.length > 0 && setIdx((idx + 1) % sorted.length),
    },
      React.createElement(StatsHeader, { caseState, current: 0, total: 0 }),
      sorted.length === 0
        ? React.createElement('div', {
            style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.fgMuted, fontFamily: F.mono, fontSize: 12 }
          }, 'noch keine Belege')
        : (allFertig
            ? (hasVorjahr
                ? React.createElement(ClaerungsModus, { caseState })
                : React.createElement(DocFocusCard, { d: current })
              )
            : React.createElement(LiveTicker, { caseState })
          ),

      // Coach unten
      React.createElement('div', {
        style: {
          position: 'absolute', bottom: 70, left: 0, right: 0,
          padding: '14px 24px',
          minHeight: 70,
        }
      },
        React.createElement('div', {
          style: { fontFamily: F.mono, fontSize: 8, letterSpacing: '0.16em', color: C.fgDim, textTransform: 'uppercase', marginBottom: 6 }
        }, 'COACH'),
        React.createElement('div', {
          style: { fontSize: 13, lineHeight: 1.5, color: C.fg, minHeight: 40 }
        },
          typed,
          typed.length < (coachTxt || '').length && React.createElement('span', {
            style: { display: 'inline-block', width: 2, height: 14, background: C.iris, marginLeft: 2, animation: 'liveCursor 800ms infinite' }
          }),
        ),
      )
    );
  }

  // Polling deaktiviert — m-case.html ruft jetzt loadCase() bei jedem SSE-Event
  // (beleg_indikation, doc_done, doc_error) → caseStateUpdated feuert sofort.
  // Latenz Upload → Phone-Update: ~1-3s statt 2s+Polling.

  // SSE-Stream OPTIONAL — versorgt window.__narratorText falls verfügbar.
  (function attachSse() {
    try {
      const m = window.location.pathname.match(/\/m\/case\/([^/#?]+)/);
      if (!m) return;
      const caseId = decodeURIComponent(m[1]);
      const es = new EventSource('/api/m/cases/' + encodeURIComponent(caseId) + '/stream', { withCredentials: true });
      es.addEventListener('narrator.say', (ev) => {
        try {
          const d = JSON.parse(ev.data);
          if (d.text) {
            window.__narratorText = d.text;
            window.__narratorTs = Date.now();
            window.dispatchEvent(new CustomEvent('caseStateUpdated', { detail: window.__caseState }));
          }
        } catch {}
      });
      es.onerror = () => { /* silent */ };
    } catch {}
  })();

  if (!document.getElementById('live-stream-styles')) {
    const s = document.createElement('style');
    s.id = 'live-stream-styles';
    s.textContent = `
      @keyframes liveFocusIn { from { opacity: 0; transform: translateY(16px) scale(0.96); } to { opacity: 1; transform: none; } }
      @keyframes liveChipPop { 0% { opacity: 0; transform: translateY(-6px) scale(0.5); } 60% { transform: translateY(0) scale(1.08); } 100% { opacity: 1; transform: none; } }
      @keyframes liveAtomIn { from { opacity: 0; transform: translateX(12px); } to { opacity: 1; transform: none; } }
      @keyframes liveCursor { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }
    `;
    document.head.appendChild(s);
  }

  Object.assign(window, { LiveStream });
})();
