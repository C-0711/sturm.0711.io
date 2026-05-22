// screens.jsx — CTAX Mobile Ingestion Flow
// Six dark-mode screens, one action each. The pipeline is visible theater.

// ─────────────────────────────────────────────────────────────
// Tokens (mirror of OCULUS dark-mode-friendly subset)
// ─────────────────────────────────────────────────────────────
const C = {
  bg0:    '#08080c',  // Perlmutt deep black
  bg1:    '#14181f',  // Perlmutt cool dark
  bg2:    '#1e242e',
  line:   'rgba(255,255,255,0.08)',
  lineHi: 'rgba(255,255,255,0.16)',
  paper:  '#fbfaf7',
  paper2: '#f6f3ec',
  inkOnPaper: '#0b1b2b',
  fg:     '#fbfaf7',
  fgMuted:'#7a8294',  // cool muted slate
  fgDim:  '#4a5260',  // cool dim slate
  iris:   '#7a9cd8',  // Perlmutt steel blue accent
  irisHi: '#a8c0e8',  // lighter steel
  irisDim:'rgba(122,156,216,0.18)',
  gold:   '#e8c878',  // Perlmutt champagne gold verify
  goldDim:'rgba(232,200,120,0.18)',
  ok:     '#7ac0a4',
};

const F = {
  // Apple system stack — SF Pro on Apple devices, Helvetica/Inter elsewhere.
  display: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", "Inter", sans-serif',
  sans:    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Inter", sans-serif',
  mono:    '"Geist Mono", "JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace',
};

// ─────────────────────────────────────────────────────────────
// Shared chrome — every screen sits in this dark canvas
// ─────────────────────────────────────────────────────────────
function ScreenChrome({ children, glow = C.iris, glowIntensity = 0.10 }) {
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: `
        radial-gradient(140% 70% at 50% -10%, ${hexA(glow, glowIntensity)} 0%, transparent 55%),
        linear-gradient(180deg, ${C.bg0} 0%, ${C.bg1} 100%)
      `,
      overflow: 'hidden',
      fontFamily: F.sans,
      color: C.fg,
      paddingTop: 56, // below status bar / dynamic island
    }}>
      {children}
    </div>
  );
}

function hexA(hex, a) {
  // hex like #1f8f8f → rgba()
  const h = hex.replace('#','');
  const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
  return `rgba(${r},${g},${b},${a})`;
}

// Overline (mono caps)
function Overline({ children, color = C.fgDim }) {
  return (
    <div style={{
      fontFamily: F.mono, fontSize: 10.5, letterSpacing: '0.18em',
      textTransform: 'uppercase', color, fontWeight: 500,
    }}>{children}</div>
  );
}

// Primary CTA — thumb-zone button
function CTA({ children, variant = 'primary', icon }) {
  const base = {
    width: '100%', height: 56, borderRadius: 14,
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
    fontFamily: F.sans, fontSize: 17, fontWeight: 500,
    border: '1px solid transparent', cursor: 'pointer',
    letterSpacing: '-0.005em',
  };
  if (variant === 'primary') Object.assign(base, {
    background: C.iris, color: C.paper,
    borderColor: C.irisHi,
    boxShadow: `0 0 0 1px ${hexA(C.iris,0.4)}, 0 8px 24px ${hexA(C.iris,0.25)}`,
  });
  if (variant === 'ghost') Object.assign(base, {
    background: 'transparent', color: C.fg,
    border: `1px solid ${C.lineHi}`,
  });
  if (variant === 'gold') Object.assign(base, {
    background: C.gold, color: '#1a1408',
    boxShadow: `0 0 0 1px ${hexA(C.gold,0.5)}, 0 8px 24px ${hexA(C.gold,0.25)}`,
  });
  return <button style={base}>{icon}{children}</button>;
}

// Tiny inline icons (Lucide-style, 1.5px stroke)
const Ic = {
  camera: (s=20,c=C.paper) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z"/>
      <circle cx="12" cy="13" r="3.5"/>
    </svg>
  ),
  plus: (s=18,c=C.paper) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round">
      <path d="M12 5v14M5 12h14"/>
    </svg>
  ),
  check: (s=14,c=C.paper) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12l5 5 11-11"/>
    </svg>
  ),
  seal: (s=44,c='#1a1408') => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9.5"/>
      <path d="M8 12.5l3 3 5-6"/>
    </svg>
  ),
  link: (s=14,c=C.gold) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07L11 5"/>
      <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07L13 19"/>
    </svg>
  ),
};

// ─────────────────────────────────────────────────────────────
// Receipt mock — a small "tax document" card
// ─────────────────────────────────────────────────────────────
function ReceiptCard({ title = 'LOHNSTEUERBESCHEINIGUNG · 2024', scanY = null, scale = 1, paperTone = 'warm' }) {
  const w = 230 * scale, h = 290 * scale;
  return (
    <div style={{
      width: w, height: h,
      background: paperTone === 'warm' ? C.paper2 : C.paper,
      color: C.inkOnPaper,
      borderRadius: 6,
      boxShadow: '0 12px 36px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.35)',
      position: 'relative', overflow: 'hidden',
      transform: `rotate(${-1.5}deg)`,
      transformOrigin: 'center',
    }}>
      {/* letterhead */}
      <div style={{ padding: '14px 14px 0' }}>
        <div style={{ fontFamily: F.mono, fontSize: 8, letterSpacing: '0.18em', color: '#5e7790' }}>
          {title}
        </div>
        <div style={{ marginTop: 6, fontFamily: F.display, fontWeight: 600, fontSize: 11, color: '#0b1b2b', letterSpacing: '-0.01em' }}>
          Bescheinigung
        </div>
        <div style={{ height: 1, background: '#d7dee7', marginTop: 8 }} />
      </div>
      {/* fake content blocks */}
      <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[100, 60, 80, 95, 50, 75, 85, 65, 70, 90, 55, 80].map((pct, i) => (
          <div key={i} style={{ display: 'flex', gap: 6 }}>
            <div style={{ height: 4, width: `${pct*0.45}%`, background: '#243a52', opacity: 0.5, borderRadius: 1 }} />
            <div style={{ height: 4, flex: 1, background: '#b3c0d0', opacity: 0.7, borderRadius: 1 }} />
          </div>
        ))}
      </div>
      <div style={{ padding: '6px 14px', display: 'flex', gap: 8, marginTop: 4 }}>
        <div style={{ width: 40, height: 14, background: '#15273a', borderRadius: 2 }} />
        <div style={{ flex: 1 }} />
        <div style={{ width: 30, height: 14, background: '#15273a', borderRadius: 2 }} />
      </div>
      {/* scan line */}
      {scanY !== null && (
        <>
          <div style={{
            position: 'absolute', left: -10, right: -10, top: `${scanY*100}%`,
            height: 2, background: C.irisHi,
            boxShadow: `0 0 12px 2px ${C.irisHi}, 0 0 40px 8px ${hexA(C.iris, 0.6)}`,
          }} />
          {/* warm wash above the line */}
          <div style={{
            position: 'absolute', left: 0, right: 0, top: 0, height: `${scanY*100}%`,
            background: `linear-gradient(180deg, ${hexA(C.iris, 0.08)} 0%, ${hexA(C.iris, 0.18)} 100%)`,
            mixBlendMode: 'screen',
            pointerEvents: 'none',
          }} />
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SCREEN 1 — Einstieg (pre-flight)
// ─────────────────────────────────────────────────────────────
function Screen1({ active }) {
  return (
    <ScreenChrome>
      {/* breathing iris dot */}
      <div style={{ position: 'absolute', top: 110, left: 0, right: 0, display: 'flex', justifyContent: 'center' }}>
        <div style={{
          width: 8, height: 8, borderRadius: 999, background: C.irisHi,
          boxShadow: `0 0 0 6px ${hexA(C.iris,0.18)}, 0 0 0 14px ${hexA(C.iris,0.08)}, 0 0 60px 10px ${hexA(C.iris,0.5)}`,
          animation: active ? 'ctaxBreath 2.6s ease-in-out infinite' : 'none',
        }} />
      </div>

      {/* overline */}
      <div style={{ position: 'absolute', top: 80, left: 0, right: 0, textAlign: 'center' }}>
        <Overline>ctax · belege</Overline>
      </div>

      {/* headline */}
      <div style={{ position: 'absolute', top: 200, left: 28, right: 28, textAlign: 'center' }}>
        <div style={{
          fontFamily: F.display, fontWeight: 700, fontSize: 40,
          lineHeight: 1.05, color: C.paper, letterSpacing: '-0.028em',
        }}>
          Schick mir<br/>deine Belege.
        </div>
        <div style={{ marginTop: 18, fontSize: 15, color: C.fgMuted, lineHeight: 1.45 }}>
          Foto, WhatsApp oder PDF.<br/>Ich erkenne den Rest.
        </div>
      </div>

      {/* thumb zone */}
      <div style={{ position: 'absolute', bottom: 60, left: 24, right: 24 }}>
        <CTA variant="primary" icon={Ic.plus(20, C.paper)}>Beleg hinzufügen</CTA>
      </div>
    </ScreenChrome>
  );
}

// ─────────────────────────────────────────────────────────────
// SCREEN 2 — Belege wählen (file picker, multi-source)
// ─────────────────────────────────────────────────────────────
function ScreenPicker({ active }) {
  const [selected, setSelected] = React.useState([0, 2, 5]);
  const [tab, setTab] = React.useState('fotos');

  const items = [
    { kind: 'lohn',     label: 'LOHNSTEUER · 2024' },
    { kind: 'kapital',  label: 'DKB · ERTRÄGE' },
    { kind: 'spende',   label: 'WWF · SPENDE' },
    { kind: 'rechnung', label: 'RECHNUNG · OPTIK' },
    { kind: 'lohn',     label: 'LOHNSTEUER · LARA' },
    { kind: 'elster',   label: 'ELSTER · BESCH.' },
    { kind: 'kapital',  label: 'ING · ZINSEN' },
    { kind: 'rechnung', label: 'BAHN · 2024' },
    { kind: 'sonst',    label: 'IMG_2891.JPG' },
  ];

  const toggle = (i) => {
    setSelected((s) => s.includes(i) ? s.filter((x) => x !== i) : [...s, i]);
  };

  // Mini-receipt thumbnail content
  const thumbContent = (label, i) => (
    <div style={{ padding: 6 }}>
      <div style={{ fontFamily: F.mono, fontSize: 5, letterSpacing: '0.14em', color: '#5e7790', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {label}
      </div>
      <div style={{ marginTop: 5, height: 1, background: '#d7dee7' }} />
      <div style={{ marginTop: 5, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {[80, 60, 90, 50, 70, 85, 65, 75, 55, 80, 65, 70].map((w, j) => (
          <div key={j} style={{ height: 1.5, width: `${w}%`, background: '#243a52', opacity: 0.45, borderRadius: 1 }} />
        ))}
      </div>
    </div>
  );

  return (
    <ScreenChrome glow={C.iris} glowIntensity={0.05}>
      {/* nav bar (iOS-style) */}
      <div style={{ position: 'absolute', top: 56, left: 0, right: 0, padding: '10px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <button style={{ background: 'none', border: 'none', color: C.irisHi, fontSize: 17, fontFamily: F.sans, fontWeight: 400, cursor: 'pointer', padding: 0 }}>Abbrechen</button>
        <div style={{ fontFamily: F.mono, fontSize: 10, color: C.fgDim, letterSpacing: '0.16em', textTransform: 'uppercase' }}>02 · Quelle</div>
        <button style={{ background: 'rgba(255,255,255,0.08)', border: `1px solid ${C.lineHi}`, borderRadius: 999, width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 }}>
          {Ic.camera(16, C.paper)}
        </button>
      </div>

      {/* title */}
      <div style={{ position: 'absolute', top: 108, left: 22, right: 22 }}>
        <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 34, color: C.paper, letterSpacing: '-0.028em', lineHeight: 1.05 }}>
          Belege wählen.
        </div>
        <div style={{ marginTop: 6, fontSize: 14, color: C.fgMuted }}>
          {selected.length === 0 ? 'Tippe um zu wählen.' : `${selected.length} ausgewählt — bereit zum Senden.`}
        </div>
      </div>

      {/* source segmented control */}
      <div style={{ position: 'absolute', top: 200, left: 22, right: 22, display: 'flex', background: 'rgba(255,255,255,0.06)', borderRadius: 10, padding: 3, gap: 0 }}>
        {[
          { id: 'fotos',    label: 'Fotos' },
          { id: 'dateien',  label: 'Dateien' },
          { id: 'whatsapp', label: 'WhatsApp' },
        ].map((t, i) => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            flex: 1, padding: '8px 0', borderRadius: 8,
            background: tab === t.id ? 'rgba(255,255,255,0.16)' : 'transparent',
            border: 'none', color: tab === t.id ? C.paper : C.fgMuted,
            fontSize: 14, fontWeight: tab === t.id ? 600 : 400,
            fontFamily: F.sans, cursor: 'pointer', letterSpacing: '-0.01em',
            transition: 'background 150ms ease, color 150ms ease',
          }}>{t.label}</button>
        ))}
      </div>

      {/* photo grid */}
      <div style={{ position: 'absolute', top: 256, left: 22, right: 22, bottom: 130 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
          {items.map((it, i) => {
            const sel = selected.includes(i);
            const num = sel ? selected.indexOf(i) + 1 : null;
            return (
              <div key={i} onClick={() => toggle(i)} style={{
                position: 'relative', aspectRatio: '3 / 4',
                background: C.paper2, borderRadius: 8, overflow: 'hidden', cursor: 'pointer',
                boxShadow: sel
                  ? `0 0 0 3px ${C.iris}, 0 0 24px ${hexA(C.iris, 0.3)}`
                  : 'inset 0 0 0 1px rgba(255,255,255,0.06)',
                transition: 'box-shadow 150ms ease, transform 150ms ease',
                transform: sel ? 'scale(0.96)' : 'scale(1)',
              }}>
                {thumbContent(it.label, i)}
                {/* selection circle */}
                <div style={{
                  position: 'absolute', top: 6, right: 6,
                  width: 22, height: 22, borderRadius: 999,
                  background: sel ? C.iris : 'rgba(0,0,0,0.4)',
                  border: sel ? `1px solid ${C.irisHi}` : '1.5px solid rgba(255,255,255,0.85)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#fff', fontSize: 12, fontWeight: 600, fontFamily: F.sans,
                  boxShadow: sel ? `0 0 10px ${hexA(C.iris, 0.5)}` : 'none',
                  fontVariantNumeric: 'tabular-nums',
                }}>{num || ''}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* primary CTA */}
      <div style={{ position: 'absolute', bottom: 56, left: 22, right: 22 }}>
        <CTA variant={selected.length > 0 ? 'primary' : 'ghost'} icon={selected.length > 0 ? Ic.check(18, C.paper) : null}>
          {selected.length > 0 ? `${selected.length} Belege senden` : 'Bitte wählen'}
        </CTA>
      </div>
    </ScreenChrome>
  );
}

// ─────────────────────────────────────────────────────────────
// SCREEN 3 — Aufnahme (camera viewfinder, phase 1 UPLOAD)
// ─────────────────────────────────────────────────────────────
function Screen2({ active }) {
  return (
    <ScreenChrome glow={C.iris} glowIntensity={0.03}>
      {/* overline */}
      <div style={{ position: 'absolute', top: 78, left: 0, right: 0, textAlign: 'center' }}>
        <Overline color={C.fgMuted}>Phase 01 · Aufnahme</Overline>
      </div>
      <div style={{ position: 'absolute', top: 102, left: 0, right: 0, textAlign: 'center' }}>
        <div style={{ fontFamily: F.display, fontWeight: 600, fontSize: 22, color: C.paper, letterSpacing: '-0.02em' }}>
          Halte ruhig.
        </div>
      </div>

      {/* viewfinder */}
      <div style={{
        position: 'absolute', top: 170, left: 28, right: 28, height: 360,
        borderRadius: 12,
        background: '#0a1620',
        overflow: 'hidden',
      }}>
        {/* the receipt being framed */}
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{ transform: 'rotate(2deg) scale(0.95)' }}>
            <ReceiptCard scale={0.78} title="LOHNSTEUERBESCHEINIGUNG · 2024" />
          </div>
        </div>

        {/* focus brackets — animated snap */}
        {[
          { top: 32, left: 24, dx: 0, dy: 0 },
          { top: 32, right: 24, dx: -16, dy: 0, rot: 90 },
          { bottom: 32, left: 24, dx: 0, dy: -16, rot: -90 },
          { bottom: 32, right: 24, dx: -16, dy: -16, rot: 180 },
        ].map((p, i) => (
          <div key={i} style={{
            position: 'absolute', top: p.top, bottom: p.bottom, left: p.left, right: p.right,
            width: 20, height: 20,
            transform: `rotate(${p.rot || 0}deg)`,
            animation: active ? `ctaxSnap 1.6s ${i*120}ms ease-out infinite` : 'none',
          }}>
            <div style={{ position: 'absolute', top: 0, left: 0, width: 18, height: 2, background: C.irisHi }} />
            <div style={{ position: 'absolute', top: 0, left: 0, width: 2, height: 18, background: C.irisHi }} />
          </div>
        ))}

        {/* center dot */}
        <div style={{
          position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
          width: 4, height: 4, borderRadius: 999, background: C.irisHi,
        }} />
      </div>

      {/* shutter */}
      <div style={{ position: 'absolute', bottom: 56, left: 0, right: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 36 }}>
        <div style={{ width: 52, height: 52, borderRadius: 12, border: `1px solid ${C.lineHi}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F.mono, fontSize: 11, color: C.fgMuted }}>
          PDF
        </div>
        <div style={{ width: 78, height: 78, borderRadius: 999, border: `2px solid ${C.paper}`, padding: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ flex: 1, height: '100%', borderRadius: 999, background: C.paper }} />
        </div>
        <div style={{ width: 52, height: 52, borderRadius: 12, border: `1px solid ${C.lineHi}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 18, height: 18, borderRadius: 4, background: C.lineHi }} />
        </div>
      </div>
    </ScreenChrome>
  );
}

// ─────────────────────────────────────────────────────────────
// SCREEN 3 — Die Lesestube (THE THEATER · phases 2, 3, 6)
// ─────────────────────────────────────────────────────────────
function Screen3({ active, caseState }) {
  // Live-Daten aus dem Case (falls vorhanden), sonst Mock 47/2.
  const liveValues = React.useMemo(() => {
    if (!caseState?.documents) return null;
    let valueCount = 0;
    const idSet = new Set();
    for (const d of caseState.documents) {
      const w = d?.indikation?.wichtige_werte;
      if (Array.isArray(w)) valueCount += w.length;
      if (typeof d?.fieldsExtracted === 'number') valueCount += d.fieldsExtracted;
      const all = JSON.stringify(d?.indikation || {});
      const idMatches = all.match(/\b\d{11}\b/g);
      if (idMatches) idMatches.forEach(id => idSet.add(id));
    }
    return { maxCount: Math.max(1, valueCount), maxPeople: Math.max(1, idSet.size) };
  }, [caseState]);
  const TARGET_COUNT  = liveValues?.maxCount  ?? 47;
  const TARGET_PEOPLE = liveValues?.maxPeople ?? 2;

  // Animation state — auto-progressing scan + counter
  const [t, setT] = React.useState(0); // 0..1 per receipt cycle
  const [count, setCount] = React.useState(active ? 0 : TARGET_COUNT);
  const [people, setPeople] = React.useState(active ? 0 : TARGET_PEOPLE);
  const [receiptIdx, setReceiptIdx] = React.useState(0);
  const [motes, setMotes] = React.useState([]);

  React.useEffect(() => {
    if (!active) { setCount(TARGET_COUNT); setPeople(TARGET_PEOPLE); return; }
    let raf;
    const start = performance.now();
    const tick = (now) => {
      const elapsed = (now - start) / 1000;
      const phase = (elapsed % 4) / 4; // 4s per receipt
      setT(phase);
      // count goes up across cycles
      const totalCycles = Math.floor(elapsed / 4);
      const inCycle = phase;
      const target = Math.min(TARGET_COUNT, totalCycles * 7 + Math.floor(inCycle * 7));
      setCount(target);
      setPeople(elapsed > 6 ? TARGET_PEOPLE : (elapsed > 3 ? 1 : 0));
      setReceiptIdx(totalCycles % 3);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, TARGET_COUNT, TARGET_PEOPLE]);

  // Spawn motes whenever count changes (in animation)
  React.useEffect(() => {
    if (!active) return;
    const id = Math.random();
    setMotes((m) => [...m.slice(-8), { id, x: 30 + Math.random()*60, key: count }]);
    const tm = setTimeout(() => {
      setMotes((m) => m.filter((mo) => mo.key !== count));
    }, 900);
    return () => clearTimeout(tm);
  }, [count, active]);

  const phases = [
    { label: 'sehen',     done: t > 0.10 },
    { label: 'erkennen',  done: t > 0.30 },
    { label: 'auslesen',  done: t > 0.55 },
    { label: 'verknüpfen',done: t > 0.75 },
    { label: 'speichern', done: t > 0.92 },
    { label: 'fertig',    done: t > 0.98 },
  ];

  const titles = [
    'LOHNSTEUERBESCHEINIGUNG · 2024',
    'KAPITALERTRÄGE · 2024',
    'SPENDENQUITTUNG · 2024',
  ];
  const friendly = [
    'Lese deine Lohnsteuer',
    'Lese deine Kapitalerträge',
    'Lese deine Spenden',
  ];

  return (
    <ScreenChrome glow={C.iris} glowIntensity={0.12}>
      {/* counter (top) */}
      <div style={{ position: 'absolute', top: 76, left: 24, right: 24, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div>
          <div style={{
            fontFamily: F.mono, fontSize: 56, fontWeight: 500, color: C.paper,
            fontVariantNumeric: 'tabular-nums', lineHeight: 1, letterSpacing: '-0.02em',
          }}>{String(count).padStart(2,'0')}</div>
          <div style={{ marginTop: 4, fontSize: 13, color: C.fgMuted }}>Werte erkannt</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{
            fontFamily: F.mono, fontSize: 28, color: C.paper,
            fontVariantNumeric: 'tabular-nums', lineHeight: 1,
          }}>{people}</div>
          <div style={{ marginTop: 4, fontSize: 12, color: C.fgMuted }}>Personen</div>
        </div>
      </div>

      {/* motes flying up */}
      {motes.map((m) => (
        <div key={m.id} style={{
          position: 'absolute', left: `${m.x}%`, bottom: '40%',
          fontFamily: F.mono, fontSize: 12, color: C.irisHi,
          animation: 'ctaxMote 900ms ease-out forwards',
          pointerEvents: 'none',
        }}>+1</div>
      ))}

      {/* center stage */}
      <div style={{
        position: 'absolute', top: 200, left: 0, right: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18,
      }}>
        <div style={{ transform: 'rotate(2deg)' }}>
          <ReceiptCard
            scale={0.85}
            title={titles[receiptIdx]}
            scanY={active ? Math.min(1, t * 1.2) : 0.5}
          />
        </div>

        {/* phase comet */}
        <div style={{ width: 230, padding: '0 4px' }}>
          <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
            {phases.map((p, i) => (
              <div key={i} style={{
                flex: 1, height: 3, borderRadius: 1,
                background: p.done ? C.irisHi : C.lineHi,
                boxShadow: p.done ? `0 0 8px ${hexA(C.irisHi, 0.6)}` : 'none',
                transition: 'background 200ms ease, box-shadow 200ms ease',
              }} />
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: F.mono, fontSize: 9, color: C.fgDim, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
            <span>{phases.find(p => !p.done)?.label || 'fertig'}</span>
            <span>{phases.filter(p => p.done).length}/6</span>
          </div>
        </div>
      </div>

      {/* microtext (status line) */}
      <div style={{ position: 'absolute', bottom: 156, left: 24, right: 24, textAlign: 'center' }}>
        <div style={{ fontFamily: F.display, fontWeight: 600, fontSize: 20, color: C.paper, lineHeight: 1.25, letterSpacing: '-0.02em' }}>
          {active ? friendly[receiptIdx] : friendly[0]} …
        </div>
        <div style={{ marginTop: 6, fontSize: 13, color: C.fgMuted }}>
          {count > 0 ? `${count} Werte gefunden` : 'einen Moment'}
        </div>
      </div>

      {/* thumb-zone FAB — add more anytime */}
      <div style={{ position: 'absolute', bottom: 60, left: 24, right: 24 }}>
        <CTA variant="ghost" icon={Ic.plus(18)}>Weiteren Beleg hinzufügen</CTA>
      </div>
    </ScreenChrome>
  );
}

// ─────────────────────────────────────────────────────────────
// SCREEN 4 — Personen erkannt (phase 4)
// ─────────────────────────────────────────────────────────────
function Screen4({ active }) {
  return (
    <ScreenChrome glow={C.iris} glowIntensity={0.08}>
      <div style={{ position: 'absolute', top: 80, left: 0, right: 0, textAlign: 'center' }}>
        <Overline>Phase 04 · Personen</Overline>
      </div>

      {/* avatars */}
      <div style={{
        position: 'absolute', top: 230, left: 0, right: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0,
      }}>
        {/* avatar A */}
        <div style={{
          width: 88, height: 88, borderRadius: 999,
          background: `radial-gradient(circle at 30% 30%, ${C.paper2}, ${C.fgMuted})`,
          color: C.inkOnPaper, fontFamily: F.display, fontWeight: 600, fontSize: 34, letterSpacing: '-0.02em',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: `0 0 0 2px ${hexA(C.iris,0.3)}, 0 8px 24px rgba(0,0,0,0.4)`,
          animation: active ? 'ctaxPop 700ms 100ms ease-out both' : 'none',
        }}>M</div>

        {/* connecting line */}
        <div style={{
          width: 72, height: 2,
          background: `linear-gradient(90deg, ${C.iris}, ${C.irisHi}, ${C.iris})`,
          boxShadow: `0 0 8px ${hexA(C.irisHi, 0.7)}`,
          animation: active ? 'ctaxLineDraw 600ms 500ms ease-out both' : 'none',
          transformOrigin: 'left',
        }} />

        {/* avatar B */}
        <div style={{
          width: 88, height: 88, borderRadius: 999,
          background: `radial-gradient(circle at 30% 30%, ${C.paper}, ${C.fgDim})`,
          color: C.inkOnPaper, fontFamily: F.display, fontWeight: 600, fontSize: 34, letterSpacing: '-0.02em',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: `0 0 0 2px ${hexA(C.iris,0.3)}, 0 8px 24px rgba(0,0,0,0.4)`,
          animation: active ? 'ctaxPop 700ms 800ms ease-out both' : 'none',
        }}>L</div>
      </div>

      {/* labels under avatars */}
      <div style={{
        position: 'absolute', top: 330, left: 0, right: 0,
        display: 'flex', justifyContent: 'center', gap: 72, fontFamily: F.mono, fontSize: 11, color: C.fgMuted, letterSpacing: '0.06em', textTransform: 'uppercase',
      }}>
        <div style={{ width: 88, textAlign: 'center' }}>Du</div>
        <div style={{ width: 88, textAlign: 'center' }}>Lara</div>
      </div>

      {/* hero copy */}
      <div style={{ position: 'absolute', top: 400, left: 28, right: 28, textAlign: 'center' }}>
        <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 34, color: C.paper, lineHeight: 1.05, letterSpacing: '-0.028em' }}>
          Du und Lara.
        </div>
        <div style={{ marginTop: 12, fontSize: 14, color: C.fgMuted, lineHeight: 1.5 }}>
          Beide Lohnsteuern verknüpft.<br/>Eine gemeinsame Akte.
        </div>
      </div>

      <div style={{ position: 'absolute', bottom: 60, left: 24, right: 24 }}>
        <CTA variant="primary">Weiter</CTA>
      </div>
    </ScreenChrome>
  );
}

// ─────────────────────────────────────────────────────────────
// SCREEN 5 — Versiegelt (phase 5 STATE-COMMIT · gold-seal moment)
// ─────────────────────────────────────────────────────────────
function Screen5({ active }) {
  return (
    <ScreenChrome glow={C.gold} glowIntensity={0.12}>
      <div style={{ position: 'absolute', top: 80, left: 0, right: 0, textAlign: 'center' }}>
        <Overline color={C.gold}>Phase 05 · Gespeichert</Overline>
      </div>

      {/* gold seal */}
      <div style={{
        position: 'absolute', top: 220, left: 0, right: 0,
        display: 'flex', justifyContent: 'center',
      }}>
        <div style={{
          width: 112, height: 112, borderRadius: 999,
          background: `radial-gradient(circle at 32% 32%, #f0d878, ${C.gold} 70%)`,
          color: '#1a1408',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: `0 0 0 2px ${hexA(C.gold,0.4)}, 0 0 80px ${hexA(C.gold, 0.4)}, inset 0 -8px 24px rgba(0,0,0,0.18)`,
          animation: active ? 'ctaxStamp 700ms ease-out both' : 'none',
        }}>
          {Ic.seal(54, '#1a1408')}
        </div>
      </div>

      {/* ring pulse on stamp */}
      <div style={{
        position: 'absolute', top: 220, left: 0, right: 0, display: 'flex', justifyContent: 'center', pointerEvents: 'none',
      }}>
        <div style={{
          width: 112, height: 112, borderRadius: 999,
          border: `1px solid ${C.gold}`,
          animation: active ? 'ctaxRing 1400ms 500ms ease-out forwards' : 'none',
          opacity: 0,
        }} />
      </div>

      {/* hero copy */}
      <div style={{ position: 'absolute', top: 380, left: 28, right: 28, textAlign: 'center' }}>
        <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 40, color: C.paper, lineHeight: 1.02, letterSpacing: '-0.028em' }}>
          Versiegelt.
        </div>
        <div style={{ marginTop: 14, fontSize: 14, color: C.fgMuted, lineHeight: 1.5 }}>
          32 Felder · 1 Beleg · sicher abgelegt.
        </div>

        {/* anchor pill — borrowed from OCULUS GitChain */}
        <div style={{ marginTop: 16, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: hexA(C.gold, 0.1), border: `1px solid ${hexA(C.gold, 0.35)}`, borderRadius: 999, fontFamily: F.mono, fontSize: 11, color: C.gold, letterSpacing: '0.04em' }}>
          {Ic.link(12, C.gold)} 03:14 UTC · #a1c8f2
        </div>
      </div>

      <div style={{ position: 'absolute', bottom: 60, left: 24, right: 24 }}>
        <CTA variant="primary">Weiter</CTA>
      </div>
    </ScreenChrome>
  );
}

// ─────────────────────────────────────────────────────────────
// SCREEN 6 — Zwischenbilanz (phase 6 WERTE-DELTA)
// ─────────────────────────────────────────────────────────────
function Screen6({ active }) {
  return (
    <ScreenChrome glow={C.iris} glowIntensity={0.10}>
      <div style={{ position: 'absolute', top: 80, left: 0, right: 0, textAlign: 'center' }}>
        <Overline>Zwischenbilanz</Overline>
      </div>

      {/* big number */}
      <div style={{ position: 'absolute', top: 130, left: 0, right: 0, textAlign: 'center' }}>
        <div style={{
          fontFamily: F.display, fontWeight: 700, fontSize: 168, color: C.paper,
          lineHeight: 0.9, letterSpacing: '-0.05em',
          animation: active ? 'ctaxNumber 800ms ease-out both' : 'none',
        }}>47</div>
        <div style={{ marginTop: 4, fontSize: 15, color: C.fgMuted }}>
          Werte aus deinen Belegen
        </div>
      </div>

      {/* receipt stack indicator */}
      <div style={{ position: 'absolute', top: 400, left: 24, right: 24 }}>
        <div style={{
          display: 'flex', alignItems: 'stretch', gap: 0,
          padding: '14px 16px',
          background: hexA(C.paper, 0.04),
          border: `1px solid ${C.lineHi}`,
          borderRadius: 12,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: F.mono, fontSize: 10, color: C.fgDim, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Belege</div>
            <div style={{ marginTop: 4, fontFamily: F.mono, fontSize: 22, color: C.paper, fontVariantNumeric: 'tabular-nums' }}>7</div>
          </div>
          <div style={{ width: 1, background: C.lineHi, margin: '0 14px' }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: F.mono, fontSize: 10, color: C.fgDim, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Personen</div>
            <div style={{ marginTop: 4, fontFamily: F.mono, fontSize: 22, color: C.paper, fontVariantNumeric: 'tabular-nums' }}>2</div>
          </div>
          <div style={{ width: 1, background: C.lineHi, margin: '0 14px' }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: F.mono, fontSize: 10, color: C.fgDim, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Anker</div>
            <div style={{ marginTop: 4, fontFamily: F.mono, fontSize: 22, color: C.gold, fontVariantNumeric: 'tabular-nums', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 6, height: 6, borderRadius: 999, background: C.gold, boxShadow: `0 0 8px ${C.gold}` }} />7
            </div>
          </div>
        </div>
      </div>

      {/* thumb zone */}
      <div style={{ position: 'absolute', bottom: 56, left: 24, right: 24, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <CTA variant="primary" icon={Ic.plus(18)}>Mehr Belege senden</CTA>
        <CTA variant="ghost">Fertig — zur Übersicht</CTA>
      </div>
    </ScreenChrome>
  );
}

// ─────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────
Object.assign(window, {
  Screen1, ScreenPicker, Screen2, Screen3, Screen4, Screen5, Screen6,
  CtaxTokens: C, CtaxFonts: F,
});
