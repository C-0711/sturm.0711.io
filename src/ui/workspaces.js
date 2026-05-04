/* STURM Workspaces — list + create. Phase 1 (no auth handling, no GitChain). */

const $ = (id) => document.getElementById(id);
const grid = $('ws-grid');
const form = $('create-form');
const nameInput = $('ws-name');
const errEl = $('create-error');

async function api(path, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  const tok = localStorage.getItem('sturm-token');
  if (tok) headers['Authorization'] = `Bearer ${tok}`;
  const resp = await fetch(path, { ...opts, headers });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try { const j = await resp.json(); msg = j.message || j.error || msg; } catch {}
    throw new Error(msg);
  }
  return resp.json();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return iso; }
}

async function refreshList() {
  try {
    const list = await api('/api/workspaces');
    if (list.length === 0) {
      grid.innerHTML = '<p class="muted">Noch keine Workspaces. Lege oben einen an.</p>';
      return;
    }
    grid.innerHTML = list.map((w) => `
      <a class="ws-card" href="/workspace.html?ws=${encodeURIComponent(w.id)}">
        <div class="ws-card-name">${escapeHtml(w.name)}</div>
        <div class="ws-card-id muted">${escapeHtml(w.id)}</div>
        <div class="ws-card-meta">
          <span class="ws-pill">${w.docCount} Dok.</span>
          <span class="muted">${fmtDate(w.createdAt)}</span>
        </div>
      </a>
    `).join('');
  } catch (e) {
    grid.innerHTML = `<p class="error-text">Fehler beim Laden: ${escapeHtml(e.message)}</p>`;
  }
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  errEl.textContent = '';
  const name = nameInput.value.trim();
  if (!name) return;
  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    await api('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    nameInput.value = '';
    await refreshList();
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    submitBtn.disabled = false;
  }
});

refreshList();

// ---------- cb-chat Import ----------
const cbBtn = document.getElementById('cbchat-import-btn');
const cbStatus = document.getElementById('cbchat-import-status');
const cbModal = document.getElementById('cbchat-modal');
const cbModalFall = document.getElementById('cbchat-modal-fallId');
const cbModalName = document.getElementById('cbchat-modal-name');
const cbModalCookie = document.getElementById('cbchat-modal-cookie');
const cbModalLoad = document.getElementById('cbchat-modal-load');
const cbModalPickerWrap = document.getElementById('cbchat-modal-picker-wrap');
const cbModalPicker = document.getElementById('cbchat-modal-picker');
const cbModalCancel = document.getElementById('cbchat-modal-cancel');
const cbModalGo = document.getElementById('cbchat-modal-go');
const cbModalStatus = document.getElementById('cbchat-modal-status');

function statusLabel(status, phase) {
  const s = String(status || '').toLowerCase().trim();
  const p = String(phase || '').toLowerCase().trim();
  if (s.includes('export')) return 'Exportiert';
  if (s.includes('abgeschlossen')) return 'Abgeschlossen';
  if (s.includes('ergebnis') || p === 'result') return 'Berechnet';
  if (s.includes('berechn')) return 'In Berechnung';
  if (s.includes('checkliste') || s.includes('befragung')) return 'Befragung';
  if (s.includes('profil')) return 'Profil';
  if (s.includes('extraktion')) return 'Extraktion';
  if (s.includes('dokumente')) return 'Dokumente';
  if (!s || s === 'draft' || s === 'entwurf') return 'Entwurf';
  return status || '—';
}

function fmtFallEntry(f) {
  const titel = f.person_name || f.fall_nummer || f.fall_id.slice(0, 8);
  const jahr = f.steuerjahr ? `[${f.steuerjahr}]` : '';
  const status = statusLabel(f.status, f.session_phase);
  const proz = typeof f.vollstaendigkeit === 'number' ? ` · ${Math.round(f.vollstaendigkeit)}%` : '';
  const saldo = typeof f.saldo === 'number'
    ? (f.saldo >= 0 ? ` · +${f.saldo.toFixed(0)} €` : ` · ${f.saldo.toFixed(0)} €`)
    : '';
  return `${jahr} ${titel} — ${status}${proz}${saldo}`.trim();
}

function defaultWsName(f) {
  const titel = f.person_name || f.fall_nummer || `cb-chat ${f.fall_id.slice(0, 8)}`;
  return f.steuerjahr ? `${titel} ${f.steuerjahr}` : titel;
}

function resetModal() {
  cbModalCookie.value = '';
  cbModalName.value = '';
  cbModalFall.value = '';
  cbModalPicker.innerHTML = '';
  cbModalPickerWrap.hidden = true;
  cbModalGo.disabled = true;
  cbModalStatus.textContent = '';
}

cbBtn?.addEventListener('click', () => {
  resetModal();
  cbStatus.textContent = '';
  cbModal.hidden = false;
  setTimeout(() => cbModalCookie.focus(), 0);
});
cbModalCancel?.addEventListener('click', () => { cbModal.hidden = true; });
// Esc-Taste schließt
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && cbModal && !cbModal.hidden) cbModal.hidden = true;
});
// Klick auf Backdrop (außerhalb der Card) schließt
cbModal?.addEventListener('click', (ev) => {
  if (ev.target === cbModal) cbModal.hidden = true;
});

// Schritt 1 → 2: Cookie eingeben, Liste der Fälle holen
cbModalLoad?.addEventListener('click', async () => {
  const cookie = cbModalCookie.value.trim();
  if (!cookie) { cbModalStatus.textContent = 'Cookie fehlt.'; return; }
  cbModalLoad.disabled = true;
  cbModalStatus.textContent = 'Lade Fälle aus cb-chat…';
  try {
    const headers = { 'X-CBChat-Cookie': cookie };
    const tok = localStorage.getItem('sturm-token');
    if (tok) headers['Authorization'] = `Bearer ${tok}`;
    const resp = await fetch('/api/integrations/cb-chat/faelle', { headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    const faelle = Array.isArray(data?.faelle) ? data.faelle : [];
    if (faelle.length === 0) {
      cbModalStatus.textContent = 'Keine Fälle gefunden für dieses Konto.';
      return;
    }
    cbModalPicker.innerHTML = faelle.map((f) => {
      const label = fmtFallEntry(f);
      return `<option value="${escapeHtml(f.fall_id)}" data-name="${escapeHtml(defaultWsName(f))}">${escapeHtml(label)}</option>`;
    }).join('');
    cbModalPickerWrap.hidden = false;
    cbModalStatus.textContent = `${faelle.length} Fälle gefunden.`;
    // Auto-select first entry so „Import starten" sofort klickbar ist.
    cbModalPicker.selectedIndex = 0;
    cbModalPicker.dispatchEvent(new Event('change'));
  } catch (e) {
    cbModalStatus.textContent = `Fehler: ${e.message}`;
  } finally {
    cbModalLoad.disabled = false;
  }
});

// Schritt 2 → 3: Auswahl übernehmen
cbModalPicker?.addEventListener('change', () => {
  const opt = cbModalPicker.selectedOptions[0];
  if (!opt) { cbModalGo.disabled = true; return; }
  cbModalFall.value = opt.value;
  if (!cbModalName.value.trim()) cbModalName.value = opt.dataset.name || '';
  cbModalGo.disabled = false;
});
// Doppelklick auf einen Eintrag startet den Import direkt.
cbModalPicker?.addEventListener('dblclick', () => {
  if (!cbModalGo.disabled) cbModalGo.click();
});

// Schritt 3: Import starten
cbModalGo?.addEventListener('click', async () => {
  const fallId = cbModalFall.value.trim();
  const cookie = cbModalCookie.value.trim();
  const wsName = cbModalName.value.trim() || `cb-chat ${fallId.slice(0, 8)}`;
  if (!fallId) { cbModalStatus.textContent = 'Bitte zuerst einen Fall auswählen.'; return; }
  if (!cookie) { cbModalStatus.textContent = 'Cookie fehlt.'; return; }
  cbModalGo.disabled = true;
  cbModalStatus.textContent = 'Starte Import…';
  try {
    const headers = { 'Content-Type': 'application/json', 'X-CBChat-Cookie': cookie };
    const tok = localStorage.getItem('sturm-token');
    if (tok) headers['Authorization'] = `Bearer ${tok}`;
    const resp = await fetch('/api/integrations/cb-chat/import', {
      method: 'POST', headers,
      body: JSON.stringify({ fallId, workspaceName: wsName }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    cbModalStatus.textContent = `Job ${data.jobId.slice(0, 8)}… läuft. Wechsle zum Workspace…`;
    setTimeout(() => { window.location.href = data.workspaceUrl; }, 1200);
  } catch (e) {
    cbModalStatus.textContent = `Fehler: ${e.message}`;
  } finally {
    cbModalGo.disabled = false;
  }
});
