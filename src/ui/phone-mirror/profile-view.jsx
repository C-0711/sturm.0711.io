// profile-view.jsx — Steuerprofil als lebendes Formular im Phone.
//
// Statt Ticker oder Beleg-Karten: zeigt ein VOLLSTÄNDIGES Profil mit allen
// relevanten ELSTER-Codes. Felder sind erst grau (leer), schalten auf
// gefüllt sobald ein Beleg den Wert liefert. Pulst kurz beim Übergang.
//
// Quelle: caseState.documents[*].indikation.wichtige_werte (label-Matching)
// + caseState.merged_layer wenn vorhanden (ecode-direct).

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

  // ─── Profil-Schema ─────────────────────────────────────────────────────────
  // Kategorie → Felder. label = Anzeige im Phone, match = Pattern in
  // wichtige_werte.label, format = wie der Wert dargestellt wird (eur|text|num).
  // ─── Anlagen-Badges (Gamification) ────────────────────────────────────────
  const ANLAGEN = [
    { id: 'ESt1A',  label: 'Stamm',     emoji: '📋', color: '#7a9cd8', desc: 'Hauptvordruck' },
    { id: 'N',      label: 'Lohn',      emoji: '💼', color: '#7a9cd8', desc: 'Arbeitnehmer §19' },
    { id: 'KAP',    label: 'Kapital',   emoji: '💰', color: '#e8c878', desc: 'Zinsen & Dividenden' },
    { id: 'KAP_I',  label: 'Kap-Int',   emoji: '💸', color: '#e8c878', desc: 'Kapital im EU-Raum' },
    { id: 'R',      label: 'Renten',    emoji: '🎈', color: '#a8c0e8', desc: 'Renten & Pensionen' },
    { id: 'VOR',    label: 'Vorsorge',  emoji: '🛡️', color: '#7ac0a4', desc: 'Versicherungen §10' },
    { id: 'SA',     label: 'Sonst',     emoji: '✏️',  color: '#b899c8', desc: 'Sonderausgaben' },
    { id: 'AV',     label: 'Belastung', emoji: '⚕️', color: '#e89070', desc: 'Außergewöhnl.' },
    { id: 'HA_35a', label: 'Haushalt',  emoji: '🏠', color: '#7ac0a4', desc: 'Haushaltsnahe §35a' },
    { id: 'V',      label: 'Vermiet.',  emoji: '🏘️', color: '#c89878', desc: 'V&V' },
    { id: 'KIND',   label: 'Kind',      emoji: '👶', color: '#ffb0c0', desc: 'Kinder' },
    { id: 'AUS',    label: 'Ausland',   emoji: '🌍', color: '#a8c0e8', desc: 'AUS-Einkünfte' },
    { id: 'RAV_bAV',label: 'Riester',   emoji: '🏛️', color: '#7ac0a4', desc: 'Altersvorsorge' },
  ];

  function deriveAnlagenStatus(caseState) {
    const docs = caseState?.documents || [];
    const counts = new Map();
    for (const d of docs) {
      for (const a of (d.indikation?.anlagen || [])) {
        counts.set(a, (counts.get(a) || 0) + 1);
      }
    }
    return counts;  // Map<anlagen-id, anzahl-docs>
  }

  function AnlagenBadges({ caseState, freshBadges }) {
    const counts = React.useMemo(() => deriveAnlagenStatus(caseState), [caseState]);
    const unlocked = Array.from(counts.keys()).length;
    return React.createElement('div', { style: { margin: '0 18px 14px' } },
      React.createElement('div', {
        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }
      },
        React.createElement('div', { style: { fontFamily: F.mono, fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.fgDim } }, 'Anlagen freigeschaltet'),
        React.createElement('div', { style: { fontFamily: F.mono, fontSize: 9, color: unlocked > 0 ? C.ok : C.fgDim } }, unlocked + '/' + ANLAGEN.length),
      ),
      React.createElement('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }
      },
        ANLAGEN.map(a => {
          const count = counts.get(a.id) || 0;
          const isOn = count > 0;
          const isFresh = freshBadges.has(a.id);
          return React.createElement('div', {
            key: a.id,
            title: a.desc + (isOn ? ` · ${count} Beleg${count > 1 ? 'e' : ''}` : ' (gesperrt)'),
            style: {
              position: 'relative',
              padding: '8px 4px',
              borderRadius: 10,
              background: isOn ? a.color + '22' : 'transparent',
              border: `1px solid ${isOn ? a.color + '66' : C.line}`,
              textAlign: 'center',
              transition: 'all 320ms ease',
              animation: isFresh ? 'badgeUnlock 700ms cubic-bezier(0.34, 1.56, 0.64, 1)' : 'none',
              boxShadow: isFresh ? `0 0 24px ${a.color}` : (isOn ? `0 1px 6px ${a.color}33` : 'none'),
              filter: isOn ? 'none' : 'grayscale(1) opacity(0.35)',
            }
          },
            React.createElement('div', { style: { fontSize: 18, lineHeight: 1, marginBottom: 2 } }, a.emoji),
            React.createElement('div', {
              style: { fontSize: 8, fontFamily: F.mono, color: isOn ? a.color : C.fgDim, letterSpacing: '0.04em', textTransform: 'uppercase' }
            }, a.label),
            count > 1 && React.createElement('div', {
              style: {
                position: 'absolute', top: -4, right: -4,
                background: a.color, color: '#fff',
                fontSize: 8, fontFamily: F.mono, fontWeight: 600,
                width: 14, height: 14, borderRadius: 999,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
              }
            }, count)
          );
        })
      )
    );
  }

  const PROFILE = [
    { kat: 'Veranlagung', felder: [
      { id: 'veranl',    label: 'Veranlagungsart',    match: /veranlagungsart|veranlagung(?!sjahr)|zusammen|einzeln|gemeinsam/i,  format: 'text' },
      { id: 'stkl',      label: 'Steuerklasse',       match: /steuerklasse/i,                              format: 'text' },
      { id: 'religion',  label: 'Religion',           match: /^(religion|konfession|kirchensteuermerkmal)/i, format: 'text' },
    ]},
    { kat: 'Arbeitnehmer (§19)', felder: [
      { id: 'brutto',  label: 'Bruttoarbeitslohn',   match: /brutto.*lohn|bruttoarbeitslohn|bruttobezüge|bruttoeinnahmen/i,  format: 'eur' },
      { id: 'lst',     label: 'Lohnsteuer',          match: /(einbehaltene\s+)?lohnsteuer\b|^lst\b/i,                       format: 'eur' },
      { id: 'soli',    label: 'Soli-LSt',            match: /solidaritätszuschlag|^soli\b/i,                                format: 'eur' },
      { id: 'kist',    label: 'Kirchensteuer',       match: /kirchensteuer/i,                                                format: 'eur' },
      { id: 'pendler', label: 'Pendlerstrecke',      match: /pendler|entfernung|kilometer|km\b|fahrt.*arbeit/i,              format: 'text' },
    ]},
    { kat: 'Vorsorge (§10)', felder: [
      { id: 'rv',  label: 'Rentenversicherung AN',     match: /arbeitnehmer.*rentenversicherung|rentenversicherung\s+person/i, format: 'eur' },
      { id: 'kv',  label: 'Krankenversicherung',       match: /(arbeitnehmer.*)?krankenversicherung/i,                          format: 'eur' },
      { id: 'pv',  label: 'Pflegeversicherung',        match: /pflegeversicherung/i,                                            format: 'eur' },
      { id: 'av',  label: 'Arbeitslosenversicherung',  match: /arbeitslosenversicherung/i,                                      format: 'eur' },
    ]},
    { kat: 'Kapital (§20)', felder: [
      { id: 'kapitalertrag',  label: 'Kapitalerträge',     match: /kapitalerträge|betrag.*kapital|zinsertrag/i,    format: 'eur' },
      { id: 'kapest',         label: 'Kapitalertragsteuer', match: /kapitalertragsteuer/i,                          format: 'eur' },
    ]},
    { kat: 'Sonderausgaben', felder: [
      { id: 'spende',  label: 'Spenden',         match: /spende/i,                  format: 'eur' },
      { id: 'kist_sa', label: 'KiSt gezahlt',    match: /kirchensteuer.*gezahlt/i,  format: 'eur' },
    ]},
    { kat: 'Haushaltsnah (§35a)', felder: [
      { id: 'haushaltsnah', label: 'Haushaltsnahe Dienstl.', match: /haushaltsnah|reinigung|gartenpflege/i,                format: 'eur' },
      { id: 'handwerker',   label: 'Handwerkerleistung',     match: /rechnung|handwerk|wartung|reparatur|renovierung/i,     format: 'eur' },
      { id: 'schornstein',  label: 'Schornsteinfeger',       match: /schornstein|feuerstätten/i,                            format: 'eur' },
    ]},
  ];

  function germanNum(s) {
    if (s == null) return null;
    if (typeof s === 'number') return s;
    const t0 = String(s).replace(/[€\s]/g, '').trim();
    if (/^-?\d+\.\d{1,4}$/.test(t0)) return Number(t0);
    if (/^-?\d+$/.test(t0)) return Number(t0);
    const t = t0.replace(/\./g, '').replace(',', '.');
    const n = Number(t);
    return isFinite(n) ? n : null;
  }
  function fmtEur(s) {
    const n = germanNum(s);
    if (n == null) return s;
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: n % 1 === 0 ? 0 : 2 }).format(n);
  }
  function fmtField(value, format) {
    if (value == null || value === '') return null;
    if (format === 'eur') return fmtEur(value);
    return String(value).slice(0, 28);
  }

  // ─── Profil aus caseState ableiten ────────────────────────────────────────
  function deriveProfile(caseState) {
    const docs = caseState?.documents || [];
    const allValues = [];
    for (const d of docs) {
      const werte = d.indikation?.wichtige_werte;
      if (Array.isArray(werte)) {
        for (const w of werte) allValues.push({ ...w, _docKey: d.runId || d.filename });
      }
    }
    const result = {};
    for (const kat of PROFILE) {
      for (const f of kat.felder) {
        const hit = allValues.find(w => f.match.test(String(w.label || '')));
        if (hit) {
          result[f.id] = { value: fmtField(hit.value, f.format), raw: hit.value, docKey: hit._docKey };
        }
      }
    }
    return result;
  }

  // ─── Hauptperson aus caseState ableiten ────────────────────────────────────
  function derivePerson(caseState) {
    const docs = caseState?.documents || [];
    // Filter: keine FA/Behörde als Person
    const isAuthority = (v) => /finanzamt|bundesamt|steueramt|landesamt|stadt|gemeinde|amt\s/i.test(String(v));
    // Sammle alle Werte mit Beleg-Kontext (damit wir je nach Beleg-Typ wählen können)
    const candidates = [];
    for (const d of docs) {
      const typ = String(d.indikation?.belegtyp || '').toLowerCase();
      for (const w of (d.indikation?.wichtige_werte || [])) {
        candidates.push({ ...w, _typ: typ });
      }
    }
    let name = null;

    // 1) Bei ESt-Erklärung: "Aussteller" = Steuerpflichtige (sendet ans FA)
    for (const c of candidates) {
      if (/einkommensteuererklärung|steuererklärung/.test(c._typ) && /aussteller|steuerpflichtige/i.test(c.label) && !isAuthority(c.value)) {
        name = c.value; break;
      }
    }
    // 2) Bei Lohnsteuerbescheinigung: "Empfänger" = Arbeitnehmer
    if (!name) {
      for (const c of candidates) {
        if (/lohnsteuer|bescheinigung/.test(c._typ) && /empfänger|arbeitnehmer/i.test(c.label) && !isAuthority(c.value)) {
          name = c.value; break;
        }
      }
    }
    // 3) Bei Kapital/Spende: "Empfänger" der Bescheinigung
    if (!name) {
      for (const c of candidates) {
        if (/empfänger/i.test(c.label) && !isAuthority(c.value)) {
          name = c.value; break;
        }
      }
    }
    // 4) Vorname + Nachname Person A
    if (!name) {
      const v = candidates.find(c => /^vorname/i.test(c.label))?.value;
      const n = candidates.find(c => /^(nachname|familienname|name)/i.test(c.label) && !isAuthority(c.value))?.value;
      if (v && n) name = (v + ' ' + n).trim();
      else if (n) name = n;
    }
    // 5) Owner-Email als Fallback
    if (!name && caseState?.ownerEmail) name = caseState.ownerEmail;

    const idnr = candidates.find(c => /\b\d{11}\b/.test(String(c.value)))?.value?.match(/\b\d{11}\b/)?.[0];
    const adresse = candidates.find(c => /(straße|str\.|gasse|weg|platz|allee)/i.test(String(c.value)) && !isAuthority(c.value))?.value;
    return { name: name || '—', idnr: idnr || null, adresse: adresse || null };
  }

  // ─── Field-Row ─────────────────────────────────────────────────────────────
  function FieldRow({ f, val, fresh }) {
    const filled = !!val;
    return React.createElement('div', {
      style: {
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        padding: '4px 0', borderBottom: `1px solid ${C.line}`,
        animation: fresh ? 'profilePulse 1200ms ease-out' : 'none',
      }
    },
      React.createElement('div', {
        style: {
          fontSize: 10, color: filled ? C.fgMuted : C.fgDim,
          fontFamily: F.sans,
        }
      },
        React.createElement('span', { style: { display: 'inline-block', width: 8, marginRight: 4, color: filled ? C.ok : C.fgDim } }, filled ? '●' : '○'),
        f.label
      ),
      React.createElement('div', {
        style: {
          fontSize: 11, fontFamily: f.format === 'eur' ? F.mono : F.sans,
          color: filled ? C.gold : C.fgDim,
          fontWeight: filled ? 500 : 400,
          fontVariantNumeric: 'tabular-nums',
          maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }
      }, val ? val.value : '—')
    );
  }

  function Kategorie({ kat, vals, freshIds }) {
    const filled = kat.felder.filter(f => vals[f.id]).length;
    const total = kat.felder.length;
    return React.createElement('div', { style: { marginBottom: 12 } },
      React.createElement('div', {
        style: {
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          marginBottom: 4,
        }
      },
        React.createElement('div', {
          style: { fontFamily: F.mono, fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: filled === total ? C.ok : (filled > 0 ? C.iris : C.fgDim) }
        }, kat.kat),
        React.createElement('div', {
          style: { fontFamily: F.mono, fontSize: 9, color: filled === total ? C.ok : C.fgDim }
        }, `${filled}/${total}`),
      ),
      kat.felder.map(f =>
        React.createElement(FieldRow, { key: f.id, f, val: vals[f.id], fresh: freshIds.has(f.id) })
      )
    );
  }

  function PersonCard({ person, docCount }) {
    const initials = (person.name || '?')
      .split(/\s+/).filter(Boolean).slice(0, 2)
      .map(s => s[0]?.toUpperCase() || '').join('') || '?';
    return React.createElement('div', {
      style: {
        margin: '0 18px 14px', padding: '12px 14px',
        background: `linear-gradient(135deg, ${C.bg2} 0%, ${C.bg1} 100%)`,
        border: `1px solid ${C.line}`, borderRadius: 12,
        display: 'flex', alignItems: 'center', gap: 12,
      }
    },
      // Avatar-Disk
      React.createElement('div', {
        style: {
          width: 36, height: 36, borderRadius: 999, flexShrink: 0,
          background: `linear-gradient(135deg, ${C.iris} 0%, ${C.irisHi} 100%)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontFamily: F.display, fontWeight: 600, fontSize: 14,
          boxShadow: `0 0 14px ${C.iris}44`,
        }
      }, initials),
      // Name + Sub
      React.createElement('div', { style: { flex: 1, minWidth: 0 } },
        React.createElement('div', {
          style: { fontFamily: F.display, fontSize: 15, fontWeight: 600, color: C.fg, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
        }, person.name),
        person.idnr && React.createElement('div', {
          style: { fontSize: 10, fontFamily: F.mono, color: C.fgMuted, marginTop: 2 }
        }, 'IdNr ' + person.idnr),
        !person.idnr && person.adresse && React.createElement('div', {
          style: { fontSize: 10, color: C.fgMuted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
        }, person.adresse),
      ),
      // Doc-Count
      React.createElement('div', {
        style: { fontSize: 10, fontFamily: F.mono, color: C.fgDim, textAlign: 'right', flexShrink: 0 }
      }, docCount + ' Belege')
    );
  }

  function ProfileView({ caseState: propsCaseState }) {
    // Eigener State der auf caseStateUpdated lauscht — robuster als nur prop
    const [caseState, setCaseState] = React.useState(() => propsCaseState || window.__caseState || null);
    React.useEffect(() => {
      if (propsCaseState) setCaseState(propsCaseState);
    }, [propsCaseState]);
    React.useEffect(() => {
      const h = () => setCaseState(window.__caseState ? { ...window.__caseState } : null);
      window.addEventListener('caseStateUpdated', h);
      return () => window.removeEventListener('caseStateUpdated', h);
    }, []);

    const vals = React.useMemo(() => deriveProfile(caseState), [caseState]);
    const person = React.useMemo(() => derivePerson(caseState), [caseState]);
    const anlagenCounts = React.useMemo(() => deriveAnlagenStatus(caseState), [caseState]);
    const prevValsRef = React.useRef({});
    const prevAnlagenRef = React.useRef(new Set());
    const [freshIds, setFreshIds] = React.useState(new Set());
    const [freshBadges, setFreshBadges] = React.useState(new Set());

    // Anlagen-Diff für Badge-Unlock-Animation
    React.useEffect(() => {
      const now = new Set(anlagenCounts.keys());
      const fresh = new Set();
      for (const a of now) if (!prevAnlagenRef.current.has(a)) fresh.add(a);
      if (fresh.size > 0) {
        setFreshBadges(fresh);
        setTimeout(() => setFreshBadges(new Set()), 800);
      }
      prevAnlagenRef.current = now;
    }, [anlagenCounts]);

    React.useEffect(() => {
      const fresh = new Set();
      for (const id of Object.keys(vals)) {
        if (!prevValsRef.current[id]) fresh.add(id);
        else if (prevValsRef.current[id].value !== vals[id].value) fresh.add(id);
      }
      if (fresh.size > 0) {
        setFreshIds(fresh);
        setTimeout(() => setFreshIds(new Set()), 1300);
      }
      prevValsRef.current = vals;
    }, [vals]);

    const totalFields = PROFILE.reduce((s, k) => s + k.felder.length, 0);
    const filledFields = Object.keys(vals).length;
    const pct = Math.round((filledFields / totalFields) * 100);
    const isComplete = filledFields >= Math.floor(totalFields * 0.7);

    const docs = caseState?.documents || [];
    const verarbeitet = docs.filter(d => d.indikation || d.state === 'ok' || d.state === 'error').length;

    return React.createElement('div', {
      style: {
        position: 'absolute', inset: 0,
        background: `radial-gradient(140% 70% at 50% -10%, ${C.iris}1c 0%, transparent 55%), linear-gradient(180deg, ${C.bg0} 0%, ${C.bg1} 100%)`,
        overflow: 'hidden', fontFamily: F.sans, color: C.fg,
        display: 'flex', flexDirection: 'column',
      }
    },
      // Header
      React.createElement('div', { style: { padding: '70px 18px 8px', flexShrink: 0 } },
        React.createElement('div', {
          style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }
        },
          React.createElement('div', {
            style: { fontFamily: F.mono, fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.fgDim }
          }, 'PROFIL · ESt ' + (caseState?.veranlagungsjahr || '')),
          React.createElement('div', {
            style: { fontFamily: F.mono, fontSize: 10, color: pct >= 70 ? C.ok : C.gold }
          }, pct + '%')
        ),
        // Progress-Bar
        React.createElement('div', {
          style: { height: 3, background: C.line, borderRadius: 999, overflow: 'hidden' }
        },
          React.createElement('div', {
            style: {
              width: pct + '%', height: '100%',
              background: `linear-gradient(90deg, ${C.iris}, ${C.gold})`,
              transition: 'width 500ms ease-out',
            }
          })
        ),
        React.createElement('div', {
          style: { fontSize: 9, color: C.fgMuted, fontFamily: F.mono, marginTop: 4 }
        }, `${filledFields}/${totalFields} Felder · ${verarbeitet}/${docs.length} Belege verarbeitet`),
      ),

      // Hauptperson prominent
      React.createElement(PersonCard, { person, docCount: docs.length }),

      // Anlagen-Badges (gamification)
      React.createElement(AnlagenBadges, { caseState, freshBadges }),

      // Profil-Felder
      React.createElement('div', {
        style: {
          flex: 1, overflowY: 'auto', padding: '0 18px 14px',
          maskImage: 'linear-gradient(to bottom, transparent 0, #000 4%, #000 92%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, #000 4%, #000 92%, transparent 100%)',
        }
      },
        PROFILE.map(kat => React.createElement(Kategorie, { key: kat.kat, kat, vals, freshIds }))
      ),

      // Save-Button + Coach
      React.createElement('div', {
        style: {
          padding: '8px 18px 78px', flexShrink: 0,
          borderTop: `1px solid ${C.line}`,
          background: `linear-gradient(180deg, transparent 0%, ${C.bg0} 50%)`,
        }
      },
        isComplete
          ? React.createElement('button', {
              style: {
                width: '100%', padding: '12px 16px', borderRadius: 999, border: 'none',
                background: `linear-gradient(135deg, ${C.ok} 0%, ${C.iris} 100%)`,
                color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                fontFamily: F.sans, marginBottom: 6,
              }
            }, 'Profil speichern')
          : React.createElement('div', {
              style: { fontSize: 11, color: C.fgMuted, textAlign: 'center', marginBottom: 6 }
            }, 'noch ' + (totalFields - filledFields) + ' Felder offen…'),
        isComplete && React.createElement('button', {
          style: {
            width: '100%', padding: '8px 16px', borderRadius: 999,
            background: 'transparent', border: `1px solid ${C.line}`,
            color: C.fgMuted, fontSize: 11, cursor: 'pointer',
          }
        }, '↔ Vorjahresvergleich')
      )
    );
  }

  // CSS-Keyframes
  if (!document.getElementById('profile-view-styles')) {
    const s = document.createElement('style');
    s.id = 'profile-view-styles';
    s.textContent = `
      @keyframes profilePulse {
        0%   { background: rgba(232, 200, 120, 0.24); transform: scale(1); }
        30%  { background: rgba(232, 200, 120, 0.16); }
        100% { background: transparent; transform: scale(1); }
      }
      @keyframes badgeUnlock {
        0%   { transform: scale(0.6) rotate(-8deg); opacity: 0; filter: grayscale(1) blur(2px); }
        50%  { transform: scale(1.18) rotate(4deg); filter: grayscale(0) blur(0); }
        80%  { transform: scale(0.95) rotate(-2deg); }
        100% { transform: scale(1) rotate(0); opacity: 1; }
      }
    `;
    document.head.appendChild(s);
  }

  Object.assign(window, { ProfileView });
})();
