// phone-mirror.jsx — CTAX Case-Mirror in iOS-26-Liquid-Glass-Phone
//
// Liest window.__caseState (von m-case.html befüllt) und mounted die
// passenden Screens. Auto-Rotation alle 4s, Tap-Navigation links/rechts.
// Updates via Custom-Event 'caseStateUpdated'.

(function () {
  const { IOSDevice, Screen1, ScreenPicker, Screen2, Screen3, Screen4, Screen5, Screen6, StoryMode, LiveStream, ProfileView } = window;

  const STREAM_SCREENS = [
    { key: 'einstieg',  label: 'Einstieg',      C: Screen1 },
    { key: 'wahl',      label: 'Belege wählen', C: ScreenPicker },
    { key: 'aufnahme',  label: 'Aufnahme',      C: Screen2 },
    { key: 'verify',    label: 'Verify',        C: Screen3 },
    { key: 'senden',    label: 'Senden',        C: Screen4 },
    { key: 'ergebnis',  label: 'Ergebnis',      C: Screen6 },
  ];

  const AUTO_ROTATE_MS = 5200;

  // Story-Mode-Eligibility: ≥1 fertiger Beleg ODER Berechnung vorhanden.
  function shouldUseStoryMode(cs) {
    if (!cs) return false;
    const docs = cs.documents || [];
    const anyClassified = docs.some(d => d?.indikation?.wichtige_werte?.length > 0);
    const hasResult = !!(cs.berechnung?.ergebnis || cs.fall_daten?.berechnung?.ergebnis);
    return anyClassified || hasResult;
  }

  function PhoneMirror() {
    const [idx, setIdx] = React.useState(0);
    const [paused, setPaused] = React.useState(false);
    const [caseState, setCaseState] = React.useState(() => window.__caseState || null);
    // Mode-Toggle: 'auto' (wählt je nach State), 'story', 'stream'
    const [mode, setMode] = React.useState('auto');

    // Subscribe to case-state updates
    React.useEffect(() => {
      const handler = () => setCaseState({ ...(window.__caseState || {}) });
      window.addEventListener('caseStateUpdated', handler);
      return () => window.removeEventListener('caseStateUpdated', handler);
    }, []);

    // Auto-Mode: Live wenn LiveStream verfügbar (Standard für Detail-Seite),
    // sonst Story wenn classifiziert, sonst generic Stream.
    const effectiveMode = mode === 'auto'
      ? (ProfileView && caseState ? 'live'
         : (shouldUseStoryMode(caseState) && StoryMode ? 'story' : 'stream'))
      : mode;

    // Auto-rotation (nur für Stream-Mode)
    React.useEffect(() => {
      if (paused || effectiveMode !== 'stream') return;
      const t = setInterval(() => setIdx(i => (i + 1) % STREAM_SCREENS.length), AUTO_ROTATE_MS);
      return () => clearInterval(t);
    }, [paused, effectiveMode]);

    // Smart screen jump on case events (upload-status etc.)
    React.useEffect(() => {
      const onUpload = () => { setIdx(2); setPaused(true); setTimeout(() => setPaused(false), 8000); };
      const onClassified = () => { setIdx(3); setPaused(true); setTimeout(() => setPaused(false), 6000); };
      const onListReady = () => { setIdx(1); };
      window.addEventListener('caseUploadStarted', onUpload);
      window.addEventListener('caseBelegClassified', onClassified);
      window.addEventListener('caseListReady', onListReady);
      return () => {
        window.removeEventListener('caseUploadStarted', onUpload);
        window.removeEventListener('caseBelegClassified', onClassified);
        window.removeEventListener('caseListReady', onListReady);
      };
    }, []);

    const StreamComponent = STREAM_SCREENS[idx].C;
    let phoneContent;
    if (effectiveMode === 'live' && ProfileView) {
      phoneContent = React.createElement(ProfileView, { caseState });
    } else if (effectiveMode === 'story' && StoryMode) {
      phoneContent = React.createElement(StoryMode, { caseState });
    } else {
      phoneContent = React.createElement(StreamComponent, { active: true, caseState });
    }

    return (
      React.createElement('div', {
        style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 },
        onMouseEnter: () => setPaused(true),
        onMouseLeave: () => setPaused(false),
      },
        // Phone frame
        React.createElement(IOSDevice, {
          dark: true,
          scale: 0.78,
          children: phoneContent
        }),

        // Mode-Toggle: Story / Stream / Auto
        React.createElement('div', {
          style: { display: 'flex', gap: 6, justifyContent: 'center' }
        },
          ['auto', 'live', 'story', 'stream'].map(m =>
            React.createElement('button', {
              key: m,
              onClick: () => setMode(m),
              style: {
                padding: '3px 10px', borderRadius: 999,
                border: '1px solid var(--color-border, #e4e0d6)',
                background: mode === m ? 'var(--color-accent, #7a9cd8)' : 'transparent',
                color: mode === m ? '#fff' : 'var(--color-text-secondary, #5a5a5a)',
                fontSize: 9, fontFamily: 'ui-monospace, monospace',
                letterSpacing: '0.08em', cursor: 'pointer', textTransform: 'uppercase',
              }
            }, m)
          )
        ),

        // Stream-Screen-Tabs (nur in Stream-Mode)
        effectiveMode === 'stream' && React.createElement('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
            justifyContent: 'center', maxWidth: 320,
          }
        },
          STREAM_SCREENS.map((s, i) =>
            React.createElement('button', {
              key: s.key,
              onClick: () => setIdx(i),
              style: {
                padding: '3px 7px',
                borderRadius: 999,
                border: i === idx ? '1px solid var(--color-accent, #7a9cd8)' : '1px solid var(--color-border, #e4e0d6)',
                background: i === idx ? 'var(--color-accent, #7a9cd8)' : 'transparent',
                color: i === idx ? '#fff' : 'var(--color-text-secondary, #5a5a5a)',
                fontSize: 9,
                fontFamily: 'ui-monospace, monospace',
                letterSpacing: '0.04em',
                cursor: 'pointer',
                textTransform: 'uppercase',
              }
            }, s.label)
          )
        ),

        // Case-Mirror-Hint
        caseState && React.createElement('div', {
          style: {
            fontSize: 10, color: 'var(--color-text-tertiary, #999)',
            fontFamily: 'ui-monospace, monospace', textAlign: 'center',
            letterSpacing: '0.06em',
          }
        }, `${caseState.displayName || 'Fall'} · ${(caseState.documents?.length || 0)} Beleg${caseState.documents?.length === 1 ? '' : 'e'} · ${effectiveMode}`)
      )
    );
  }

  // Mount — defensiv, exportierbar
  function mount() {
    const host = document.getElementById('phone-mirror-host');
    if (!host) return { ok: false, reason: 'no host element' };
    if (typeof ReactDOM === 'undefined' || !ReactDOM) return { ok: false, reason: 'ReactDOM undefined' };
    host.innerHTML = '';
    host.style.cssText = '';
    try {
      if (ReactDOM.createRoot) {
        ReactDOM.createRoot(host).render(React.createElement(PhoneMirror));
      } else {
        ReactDOM.render(React.createElement(PhoneMirror), host);
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: 'mount-exception: ' + (e?.message || e) };
    }
  }

  // Loader im m-case.html ruft mountPhoneMirror() explizit nach allen Files.
  Object.assign(window, { PhoneMirror, mountPhoneMirror: mount });
})();
