// story-mode.jsx — Phone Story-Mode für CTAX Steuerfall
//
// 9-Karten-Lernvideo aus dem Case-State. Auto-Advance 5.5s, Tap = pause + detail,
// Swipe links/rechts = manuelle Navigation. Karten-Definitionen sind deklarativ
// in buildStoryCards() — leicht erweiterbar pro Fall-Shape.
//
// Render-Kontext: window.React/ReactDOM bereits global (von phone-mirror.jsx geladen).
// Exposed: window.StoryMode, window.buildStoryCards.

(function () {
  const F = window.CtaxFonts || {
    display: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", "Inter", sans-serif',
    sans:    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Inter", sans-serif',
    mono:    '"Geist Mono", "JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace',
  };
  const C = window.CtaxTokens || {
    bg0: '#08080c', bg1: '#14181f', bg2: '#1e242e',
    line: 'rgba(255,255,255,0.08)', lineHi: 'rgba(255,255,255,0.16)',
    fg: '#fbfaf7', fgMuted: '#7a8294', fgDim: '#4a5260',
    iris: '#7a9cd8', irisHi: '#a8c0e8', irisDim: 'rgba(122,156,216,0.18)',
    gold: '#e8c878', goldDim: 'rgba(232,200,120,0.18)',
    ok: '#7ac0a4', warn: '#e89070',
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers: Daten-Extraktion aus caseState
  // ─────────────────────────────────────────────────────────────────────────
  function findValue(caseState, predicate) {
    if (!caseState?.documents) return null;
    for (const d of caseState.documents) {
      const w = d?.indikation?.wichtige_werte;
      if (!Array.isArray(w)) continue;
      for (const v of w) {
        if (predicate(v, d)) return { value: v.value, label: v.label, doc: d };
      }
    }
    return null;
  }
  function sumValues(caseState, predicate) {
    if (!caseState?.documents) return { sum: 0, count: 0, items: [] };
    let sum = 0, count = 0;
    const items = [];
    for (const d of caseState.documents) {
      const w = d?.indikation?.wichtige_werte;
      if (!Array.isArray(w)) continue;
      for (const v of w) {
        if (predicate(v, d)) {
          const n = parseGermanNumber(v.value);
          if (Number.isFinite(n)) { sum += n; count++; items.push({ ...v, doc: d }); }
        }
      }
    }
    return { sum, count, items };
  }
  function parseGermanNumber(s) {
    if (typeof s !== 'string') return Number(s);
    const cleaned = s.replace(/[€\s]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.');
    return Number(cleaned);
  }
  function fmtEur(n) {
    if (!Number.isFinite(n)) return '—';
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 }).format(n);
  }
  function uniqueIdNrs(caseState) {
    const s = new Set();
    if (!caseState?.documents) return [];
    for (const d of caseState.documents) {
      const all = JSON.stringify(d?.indikation || {});
      const m = all.match(/\b\d{11}\b/g);
      if (m) m.forEach(id => s.add(id));
    }
    return Array.from(s);
  }
  function distinctBanks(caseState) {
    const s = new Set();
    if (!caseState?.documents) return [];
    for (const d of caseState.documents) {
      const issuer = d?.indikation?.wichtige_werte?.find(v => /aussteller/i.test(v.label || ''))?.value;
      const docType = d?.indikation?.belegtyp || '';
      if (issuer && /bank|sparkasse|volksbank|lbs/i.test(docType + ' ' + issuer)) s.add(issuer);
    }
    return Array.from(s);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Karten bauen
  // ─────────────────────────────────────────────────────────────────────────
  function buildStoryCards(caseState) {
    if (!caseState) return [];
    const jahr = caseState.veranlagungsjahr || new Date().getFullYear();
    const personen = uniqueIdNrs(caseState).length;
    const veranlagung = personen >= 2 ? 'Zusammenveranlagung' : 'Einzelveranlagung';
    const splittingHinweis = personen >= 2 ? 'Splittingtarif aktiv — spart gegenüber Einzel meist 3–6.000 €.' : 'Einzelveranlagung.';

    // Datenpunkte
    const brutto = findValue(caseState, v => /brutto.*lohn/i.test(v.label || ''));
    const lohnsteuer = findValue(caseState, v => /(einbehaltene\s+)?lohnsteuer/i.test(v.label || ''));
    const banks = distinctBanks(caseState);
    const kapErtraege = sumValues(caseState, v => /betrag|kapitalertr|zinser/i.test(v.label || '') && /kap|zins|bescheinigung/i.test(v.doc?.indikation?.belegtyp || ''));
    const rv = findValue(caseState, v => /arbeitnehmeranteil.*rentenversicherung/i.test(v.label || ''));
    const kv = findValue(caseState, v => /krankenversicherung/i.test(v.label || '') && /beitrag|arbeitnehmer/i.test(v.label || ''));
    const pv = findValue(caseState, v => /pflegeversicherung/i.test(v.label || '') && /beitrag|arbeitnehmer/i.test(v.label || ''));
    const av = findValue(caseState, v => /arbeitslosenversicherung/i.test(v.label || ''));
    const vorsorgeSum = [rv, kv, pv, av].map(x => parseGermanNumber(x?.value)).filter(Number.isFinite).reduce((a,b)=>a+b, 0);

    // Berechnungs-Ergebnis (falls schon gerechnet)
    const erg = caseState.berechnung?.ergebnis || caseState.fall_daten?.berechnung?.ergebnis;
    const zve = erg?.zve;
    const est = erg?.einkommensteuer;
    const erstattung = erg?.erstattung_oder_nachzahlung;

    const cards = [];

    // ─── 1. Personen & Veranlagung ─────────────────────────────────────────
    cards.push({
      id: 'personen', kind: 'persons',
      kicker: `Kapitel 01 · ${jahr}`,
      title: personen >= 2 ? 'Ihr beide.' : 'Du.',
      sub: veranlagung,
      lesson: splittingHinweis,
      personenCount: personen,
    });

    // ─── 2. Bruttoarbeitslohn + LSt ────────────────────────────────────────
    if (brutto) {
      const lstBetrag = parseGermanNumber(lohnsteuer?.value);
      cards.push({
        id: 'brutto', kind: 'bignum',
        kicker: 'Kapitel 02 · Einkünfte',
        value: parseGermanNumber(brutto.value),
        valueLabel: 'Bruttoarbeitslohn',
        sub: brutto.doc?.indikation?.wichtige_werte?.find(v => /aussteller/i.test(v.label || ''))?.value || '',
        lesson: Number.isFinite(lstBetrag)
          ? `Davon ${fmtEur(lstBetrag)} schon als Lohnsteuer vorbezahlt — wird verrechnet.`
          : 'Verrechnen wir mit deinen Vorauszahlungen.',
        valueColor: C.fg,
      });
    }

    // ─── 3. Kapitalerträge & Banken ────────────────────────────────────────
    if (banks.length > 0 || kapErtraege.sum > 0) {
      cards.push({
        id: 'kap', kind: 'banks',
        kicker: 'Kapitel 03 · Kapital',
        bankCount: banks.length,
        bankNames: banks.slice(0, 5),
        kapSum: kapErtraege.sum,
        lesson: kapErtraege.sum < (personen >= 2 ? 2000 : 1000)
          ? `Unter Sparer-Pauschbetrag — keine Steuer auf diese Zinsen.`
          : `Über Sparer-Pauschbetrag — wird besteuert.`,
      });
    }

    // ─── 4. Vorsorge ───────────────────────────────────────────────────────
    if (vorsorgeSum > 0) {
      cards.push({
        id: 'vorsorge', kind: 'shield',
        kicker: 'Kapitel 04 · Vorsorge',
        value: vorsorgeSum,
        valueLabel: 'Vorsorgeaufwand',
        breakdown: [
          rv && { label: 'Rente',   value: parseGermanNumber(rv.value) },
          kv && { label: 'Kranken', value: parseGermanNumber(kv.value) },
          pv && { label: 'Pflege',  value: parseGermanNumber(pv.value) },
          av && { label: 'Arbeitslos', value: parseGermanNumber(av.value) },
        ].filter(Boolean),
        lesson: 'Voll absetzbar nach §10 EStG. Reduziert dein zu versteuerndes Einkommen.',
      });
    }

    // ─── 5. ZvE (nur wenn berechnet) ───────────────────────────────────────
    if (Number.isFinite(zve)) {
      cards.push({
        id: 'zve', kind: 'bignum',
        kicker: 'Kapitel 05 · Bemessung',
        value: zve,
        valueLabel: 'Zu versteuerndes Einkommen',
        sub: 'Nach Werbungskosten, Vorsorge & Sonderausgaben',
        lesson: 'Darauf wird die Einkommensteuer berechnet — nicht auf den Bruttolohn.',
        valueColor: C.irisHi,
      });
    }

    // ─── 6. Einkommensteuer ────────────────────────────────────────────────
    if (Number.isFinite(est)) {
      cards.push({
        id: 'est', kind: 'bignum',
        kicker: 'Kapitel 06 · Steuer',
        value: est,
        valueLabel: 'Einkommensteuer',
        sub: personen >= 2 ? '§32a EStG · Splittingtarif' : '§32a EStG · Grundtarif',
        lesson: 'Festgesetzte Steuer für das ganze Jahr — vor Anrechnung deiner Vorauszahlungen.',
        valueColor: C.gold,
      });
    }

    // ─── 7. Erstattung / Nachzahlung ───────────────────────────────────────
    if (Number.isFinite(erstattung)) {
      const isRefund = erstattung >= 0;
      cards.push({
        id: 'ergebnis', kind: 'result',
        kicker: 'Kapitel 07 · Ergebnis',
        value: Math.abs(erstattung),
        valueLabel: isRefund ? 'Erstattung' : 'Nachzahlung',
        isRefund,
        lesson: isRefund ? 'Geld kommt vom Finanzamt zurück.' : 'Bitte ans Finanzamt nachzahlen.',
      });
    }

    // ─── 8. Vorjahresvergleich (Stub bis Vorjahr-API steht) ────────────────
    const vorjahr_erg = caseState.vorjahr?.berechnung?.ergebnis;
    if (vorjahr_erg && Number.isFinite(est) && Number.isFinite(vorjahr_erg.einkommensteuer)) {
      cards.push({
        id: 'vergleich', kind: 'compare',
        kicker: 'Kapitel 08 · Vorjahr',
        thisYear: { jahr, est },
        lastYear: { jahr: jahr - 1, est: vorjahr_erg.einkommensteuer },
        lesson: est < vorjahr_erg.einkommensteuer
          ? `${Math.round((1 - est / vorjahr_erg.einkommensteuer) * 100)}% weniger Steuer als ${jahr - 1}.`
          : `${Math.round((est / vorjahr_erg.einkommensteuer - 1) * 100)}% mehr Steuer als ${jahr - 1}.`,
      });
    }

    // ─── 9. ToDo + CTA ─────────────────────────────────────────────────────
    const todos = caseState.berechnung?.warnungen?.map(w => w.message || w.code).filter(Boolean) || [];
    cards.push({
      id: 'todo', kind: 'todo',
      kicker: 'Kapitel ' + String(cards.length + 1).padStart(2, '0') + ' · Bereit?',
      title: todos.length > 0 ? 'Noch zu prüfen' : 'Alles bereit',
      items: todos.length > 0 ? todos.slice(0, 4) : [
        'Pendlerpauschale',
        'Krankheitskosten',
        'Spenden über Pauschbetrag',
      ],
      ctaPrimary: 'An ELSTER senden',
      ctaSecondary: 'Erst prüfen',
      lesson: todos.length > 0 ? 'Diese Punkte können deine Steuer noch weiter senken.' : 'Du kannst die Erklärung jetzt einreichen.',
    });

    return cards;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Animation: Count-up Hook
  // ─────────────────────────────────────────────────────────────────────────
  function useCountUp(target, durationMs = 900, active = true) {
    const [v, setV] = React.useState(0);
    React.useEffect(() => {
      if (!active) { setV(target); return; }
      const start = performance.now();
      let raf;
      const tick = (now) => {
        const t = Math.min(1, (now - start) / durationMs);
        const eased = 1 - Math.pow(1 - t, 4); // easeOutQuart
        setV(target * eased);
        if (t < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }, [target, active, durationMs]);
    return v;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Card-Render
  // ─────────────────────────────────────────────────────────────────────────
  function ChromeWrap({ children, glow = C.iris }) {
    return React.createElement('div', {
      style: {
        position: 'absolute', inset: 0,
        background: `radial-gradient(140% 70% at 50% -10%, ${glow}1f 0%, transparent 55%), linear-gradient(180deg, ${C.bg0} 0%, ${C.bg1} 100%)`,
        overflow: 'hidden', fontFamily: F.sans, color: C.fg, paddingTop: 56,
      },
    }, children);
  }

  function Kicker({ text }) {
    return React.createElement('div', {
      style: {
        position: 'absolute', top: 72, left: 24, right: 24,
        fontFamily: F.mono, fontSize: 10, letterSpacing: '0.14em',
        textTransform: 'uppercase', color: C.fgDim, fontWeight: 500,
      }
    }, text);
  }

  function Lesson({ text, color = C.fgMuted }) {
    return React.createElement('div', {
      style: {
        position: 'absolute', bottom: 90, left: 24, right: 24,
        fontSize: 13, lineHeight: 1.5, color,
        fontFamily: F.sans, opacity: 0, animation: 'cardFadeIn 600ms 500ms forwards',
      }
    }, text);
  }

  function CardBigNum({ card, active }) {
    const v = useCountUp(card.value, 1000, active);
    return React.createElement(ChromeWrap, { glow: card.valueColor || C.iris },
      React.createElement(Kicker, { text: card.kicker }),
      React.createElement('div', {
        style: {
          position: 'absolute', top: 130, left: 24, right: 24,
          fontFamily: F.mono, fontSize: 56, fontWeight: 500, lineHeight: 1,
          color: card.valueColor || C.fg, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.03em',
        }
      }, fmtEur(v)),
      React.createElement('div', {
        style: {
          position: 'absolute', top: 200, left: 24, right: 24,
          fontSize: 14, color: C.fgMuted, fontWeight: 500,
        }
      }, card.valueLabel),
      card.sub && React.createElement('div', {
        style: {
          position: 'absolute', top: 226, left: 24, right: 24,
          fontSize: 12, color: C.fgDim, fontStyle: 'italic',
        }
      }, card.sub),
      React.createElement(Lesson, { text: card.lesson })
    );
  }

  function CardPersons({ card, active }) {
    const cnt = card.personenCount || 1;
    return React.createElement(ChromeWrap, { glow: C.iris },
      React.createElement(Kicker, { text: card.kicker }),
      React.createElement('div', {
        style: {
          position: 'absolute', top: '38%', left: 0, right: 0,
          display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 24,
        }
      },
        Array.from({ length: Math.min(2, cnt) }).map((_, i) =>
          React.createElement('div', {
            key: i,
            style: {
              width: 56, height: 56, borderRadius: 999,
              background: `linear-gradient(135deg, ${C.iris} 0%, ${C.irisHi} 100%)`,
              boxShadow: `0 0 40px ${C.iris}66`,
              animation: `cardPulse 2.4s ${i * 0.4}s infinite ease-in-out`,
            }
          })
        )
      ),
      React.createElement('div', {
        style: {
          position: 'absolute', top: '58%', left: 24, right: 24,
          textAlign: 'center', fontFamily: F.display, fontSize: 32, fontWeight: 600, color: C.fg,
        }
      }, card.title),
      React.createElement('div', {
        style: {
          position: 'absolute', top: '67%', left: 24, right: 24,
          textAlign: 'center', fontSize: 14, color: C.fgMuted,
        }
      }, card.sub),
      React.createElement(Lesson, { text: card.lesson })
    );
  }

  function CardBanks({ card }) {
    return React.createElement(ChromeWrap, { glow: C.iris },
      React.createElement(Kicker, { text: card.kicker }),
      React.createElement('div', {
        style: { position: 'absolute', top: 110, left: 24, right: 24, fontFamily: F.mono, fontSize: 56, color: C.fg, fontVariantNumeric: 'tabular-nums' }
      }, card.bankCount),
      React.createElement('div', { style: { position: 'absolute', top: 180, left: 24, right: 24, fontSize: 14, color: C.fgMuted } }, card.bankCount === 1 ? 'Bank' : 'Banken'),
      React.createElement('div', { style: { position: 'absolute', top: 210, left: 24, right: 24, display: 'flex', flexDirection: 'column', gap: 6 } },
        card.bankNames.map((b, i) =>
          React.createElement('div', {
            key: i,
            style: {
              fontSize: 11, color: C.fg, fontFamily: F.mono,
              padding: '4px 8px', background: C.bg2, borderRadius: 4,
              opacity: 0, animation: `cardSlideIn 400ms ${i * 100 + 200}ms forwards`,
            }
          }, b.length > 32 ? b.slice(0, 30) + '…' : b)
        )
      ),
      React.createElement('div', {
        style: { position: 'absolute', top: 410, left: 24, right: 24, fontSize: 14, color: C.gold, fontFamily: F.mono, fontVariantNumeric: 'tabular-nums' }
      }, `Σ ${fmtEur(card.kapSum)}`),
      React.createElement(Lesson, { text: card.lesson })
    );
  }

  function CardShield({ card, active }) {
    const v = useCountUp(card.value, 1000, active);
    return React.createElement(ChromeWrap, { glow: C.ok },
      React.createElement(Kicker, { text: card.kicker }),
      React.createElement('div', {
        style: { position: 'absolute', top: 110, left: 24, right: 24, fontFamily: F.mono, fontSize: 48, color: C.ok, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' }
      }, fmtEur(v)),
      React.createElement('div', { style: { position: 'absolute', top: 170, left: 24, right: 24, fontSize: 13, color: C.fgMuted } }, card.valueLabel),
      React.createElement('div', { style: { position: 'absolute', top: 210, left: 24, right: 24, display: 'flex', flexDirection: 'column', gap: 4 } },
        card.breakdown.map((b, i) =>
          React.createElement('div', {
            key: i,
            style: {
              display: 'flex', justifyContent: 'space-between', fontSize: 12,
              padding: '6px 10px', background: C.bg2, borderRadius: 4,
              opacity: 0, animation: `cardSlideIn 400ms ${i * 120 + 300}ms forwards`,
            }
          },
            React.createElement('span', { style: { color: C.fgMuted } }, b.label),
            React.createElement('span', { style: { color: C.fg, fontFamily: F.mono } }, fmtEur(b.value))
          )
        )
      ),
      React.createElement(Lesson, { text: card.lesson })
    );
  }

  function CardResult({ card, active }) {
    const v = useCountUp(card.value, 1100, active);
    const color = card.isRefund ? C.ok : C.warn;
    return React.createElement(ChromeWrap, { glow: color },
      React.createElement(Kicker, { text: card.kicker }),
      React.createElement('div', {
        style: { position: 'absolute', top: 130, left: 24, right: 24, fontSize: 14, color: C.fgMuted, fontFamily: F.mono, letterSpacing: '0.06em', textTransform: 'uppercase' }
      }, card.valueLabel),
      React.createElement('div', {
        style: {
          position: 'absolute', top: 160, left: 24, right: 24,
          fontFamily: F.mono, fontSize: 64, fontWeight: 500, lineHeight: 1,
          color, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.04em',
        }
      }, (card.isRefund ? '+' : '−') + fmtEur(v).replace('€','') + '€'),
      React.createElement('div', {
        style: {
          position: 'absolute', top: 270, left: '50%', transform: 'translateX(-50%)',
          width: 48, height: 48, borderRadius: 999,
          background: card.isRefund ? `radial-gradient(circle, ${C.ok} 0%, ${C.ok}33 70%)` : `radial-gradient(circle, ${C.warn} 0%, ${C.warn}33 70%)`,
          animation: 'cardSpin 3s infinite linear',
          boxShadow: `0 0 32px ${color}66`,
        }
      }),
      React.createElement(Lesson, { text: card.lesson, color: C.fg })
    );
  }

  function CardCompare({ card, active }) {
    const a = useCountUp(card.lastYear.est, 900, active);
    const b = useCountUp(card.thisYear.est, 900, active);
    const max = Math.max(card.lastYear.est, card.thisYear.est);
    return React.createElement(ChromeWrap, { glow: C.iris },
      React.createElement(Kicker, { text: card.kicker }),
      React.createElement('div', {
        style: { position: 'absolute', top: 110, left: 24, right: 24, display: 'flex', justifyContent: 'space-around', alignItems: 'flex-end', height: 200 }
      },
        [{ y: card.lastYear.jahr, v: a, color: C.fgMuted }, { y: card.thisYear.jahr, v: b, color: C.iris }].map((bar, i) =>
          React.createElement('div', {
            key: i,
            style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, width: 80 }
          },
            React.createElement('div', { style: { fontSize: 11, color: C.fgMuted, fontFamily: F.mono } }, bar.y),
            React.createElement('div', {
              style: {
                width: 40, height: (bar.v / max) * 160,
                background: bar.color,
                borderRadius: '4px 4px 0 0',
                transition: 'height 600ms ease-out',
              }
            }),
            React.createElement('div', { style: { fontSize: 12, color: bar.color, fontFamily: F.mono, fontVariantNumeric: 'tabular-nums' } }, fmtEur(bar.v))
          )
        )
      ),
      React.createElement(Lesson, { text: card.lesson, color: C.irisHi })
    );
  }

  function CardTodo({ card }) {
    return React.createElement(ChromeWrap, { glow: C.gold },
      React.createElement(Kicker, { text: card.kicker }),
      React.createElement('div', {
        style: { position: 'absolute', top: 110, left: 24, right: 24, fontFamily: F.display, fontSize: 28, color: C.fg, fontWeight: 600 }
      }, card.title),
      React.createElement('div', { style: { position: 'absolute', top: 170, left: 24, right: 24, display: 'flex', flexDirection: 'column', gap: 8 } },
        card.items.map((t, i) =>
          React.createElement('div', {
            key: i,
            style: {
              display: 'flex', gap: 10, alignItems: 'center', fontSize: 13, color: C.fg,
              padding: '8px 12px', background: C.bg2, borderRadius: 6,
              opacity: 0, animation: `cardSlideIn 400ms ${i * 120 + 300}ms forwards`,
            }
          },
            React.createElement('span', { style: { color: C.gold, fontFamily: F.mono } }, '☐'),
            React.createElement('span', null, t)
          )
        )
      ),
      React.createElement('div', { style: { position: 'absolute', bottom: 110, left: 24, right: 24, display: 'flex', flexDirection: 'column', gap: 8 } },
        React.createElement('button', {
          style: {
            padding: '12px 16px', borderRadius: 999, border: 'none',
            background: `linear-gradient(135deg, ${C.iris} 0%, ${C.irisHi} 100%)`,
            color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
            fontFamily: F.sans,
          }
        }, card.ctaPrimary),
        React.createElement('button', {
          style: {
            padding: '10px 16px', borderRadius: 999,
            background: 'transparent', border: `1px solid ${C.line}`,
            color: C.fgMuted, fontSize: 13, cursor: 'pointer',
            fontFamily: F.sans,
          }
        }, card.ctaSecondary)
      )
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // StoryMode — Hauptkomponente
  // ─────────────────────────────────────────────────────────────────────────
  const AUTO_MS = 5800;

  function StoryMode({ caseState }) {
    const cards = React.useMemo(() => buildStoryCards(caseState), [caseState]);
    const [idx, setIdx] = React.useState(0);
    const [paused, setPaused] = React.useState(false);

    React.useEffect(() => {
      if (paused || cards.length === 0) return;
      const t = setTimeout(() => setIdx(i => (i + 1) % cards.length), AUTO_MS);
      return () => clearTimeout(t);
    }, [idx, paused, cards.length]);

    if (cards.length === 0) {
      return React.createElement('div', { style: { color: C.fgMuted, padding: 24, textAlign: 'center', fontSize: 13 } }, 'Lade Story…');
    }

    const card = cards[idx];
    const renderer = {
      bignum:  CardBigNum,
      persons: CardPersons,
      banks:   CardBanks,
      shield:  CardShield,
      result:  CardResult,
      compare: CardCompare,
      todo:    CardTodo,
    }[card.kind] || CardBigNum;

    return React.createElement('div', {
      key: card.id,
      style: { position: 'absolute', inset: 0 },
      onMouseEnter: () => setPaused(true),
      onMouseLeave: () => setPaused(false),
      onClick: () => setIdx(i => (i + 1) % cards.length),
    },
      // Progress dots
      React.createElement('div', {
        style: {
          position: 'absolute', top: 8, left: 24, right: 24, zIndex: 20,
          display: 'flex', gap: 4,
        }
      },
        cards.map((_, i) =>
          React.createElement('div', {
            key: i,
            style: {
              flex: 1, height: 2, borderRadius: 1,
              background: i < idx ? C.iris : (i === idx ? C.iris : C.line),
              opacity: i === idx ? 1 : (i < idx ? 0.6 : 0.3),
              transition: 'all 400ms ease',
            }
          })
        )
      ),
      React.createElement(renderer, { card, active: true })
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Inject CSS keyframes
  // ─────────────────────────────────────────────────────────────────────────
  if (!document.getElementById('story-mode-styles')) {
    const s = document.createElement('style');
    s.id = 'story-mode-styles';
    s.textContent = `
      @keyframes cardFadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
      @keyframes cardSlideIn { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: none; } }
      @keyframes cardPulse { 0%, 100% { transform: scale(1); opacity: 0.95; } 50% { transform: scale(1.12); opacity: 1; } }
      @keyframes cardSpin { from { transform: translateX(-50%) rotate(0deg); } to { transform: translateX(-50%) rotate(360deg); } }
    `;
    document.head.appendChild(s);
  }

  Object.assign(window, { StoryMode, buildStoryCards });
})();
