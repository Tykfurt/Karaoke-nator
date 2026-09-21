let pin = sessionStorage.getItem('karaoke_admin_pin') || '';
let lastQueue = [];
let lastPlayer = { isPlaying: false, currentSongId: null };
let currentEditId = null;

async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json', 'x-admin-pin': pin }, opts.headers || {});
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error inesperado');
  return data;
}

async function tryLogin(p) {
  const res = await fetch('/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: p })
  });
  return res.ok;
}

document.getElementById('btnLogin').addEventListener('click', async () => {
  const p = document.getElementById('pin').value.trim();
  if (!p) return showToast('Ingresa el PIN', true);
  const ok = await tryLogin(p);
  if (!ok) return showToast('PIN incorrecto', true);
  pin = p;
  sessionStorage.setItem('karaoke_admin_pin', pin);
  initPanel();
});

async function initPanel() {
  document.getElementById('loginCard').style.display = 'none';
  document.getElementById('panel').style.display = 'block';
  loadQR('local');
  refreshTunnelStatus();
  setInterval(refreshTunnelStatus, 4000); // cloudflared puede tardar unos segundos en arrancar
  connectWS((msg) => {
    if (msg.type === 'queue_update') {
      lastQueue = msg.queue; lastPlayer = msg.player;
      render();
    }
    if (msg.type === 'notice') {
      showToast(msg.message, true);
    }
  });
  try {
    const { queue, player } = await api('/api/queue');
    lastQueue = queue; lastPlayer = player;
    render();
  } catch (e) { /* ignore */ }
}

// Auto-login si ya había sesión (mismo navegador)
if (pin) tryLogin(pin).then(ok => { if (ok) initPanel(); else sessionStorage.removeItem('karaoke_admin_pin'); });

let qrMode = 'local';
let tunnelInfo = { active: false, url: null };

async function loadQR(mode) {
  qrMode = mode || qrMode;
  document.getElementById('tabLocal').classList.toggle('active', qrMode === 'local');
  document.getElementById('tabPublic').classList.toggle('active', qrMode === 'public');

  try {
    let query = 'mode=' + qrMode;
    if (qrMode === 'local') {
      const { ips } = await (await fetch('/api/admin/ips', { headers: { 'x-admin-pin': pin } })).json();
      if (ips[0]) query += '&ip=' + ips[0];
    }
    const res = await fetch('/api/admin/qr?' + query, { headers: { 'x-admin-pin': pin } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    document.getElementById('qrImg').style.visibility = 'visible';
    document.getElementById('qrImg').src = data.dataUrl;
    document.getElementById('qrUrl').textContent = data.url;
  } catch (e) {
    document.getElementById('qrImg').style.visibility = 'hidden';
    document.getElementById('qrUrl').textContent = '';
    showToast(e.message, true);
  }
}

async function refreshTunnelStatus() {
  try {
    const res = await fetch('/api/admin/tunnel-status', { headers: { 'x-admin-pin': pin } });
    tunnelInfo = await res.json();
    const el = document.getElementById('tunnelStatus');
    if (tunnelInfo.active) {
      el.textContent = '🌍 Acceso por internet activo';
      el.style.color = 'var(--ok)';
    } else {
      el.textContent = '📴 Acceso por internet no disponible (falta cloudflared, ver README) — usa Wi-Fi local mientras tanto';
      el.style.color = 'var(--muted)';
    }
  } catch (e) { /* ignore */ }
}

document.getElementById('tabLocal').addEventListener('click', () => loadQR('local'));
document.getElementById('tabPublic').addEventListener('click', () => {
  if (!tunnelInfo.active) return showToast('El acceso por internet aún no está listo o no está configurado', true);
  loadQR('public');
});

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(str) { return escapeHtml(str).replace(/'/g, '&#39;'); }

function render() {
  const playing = lastQueue.find(s => s.id === lastPlayer.currentSongId);
  document.getElementById('nowPlaying').textContent = playing ? playing.displayName : '— Nada en reproducción —';

  const list = document.getElementById('queueList');
  if (!lastQueue.length) {
    list.innerHTML = '<div class="empty">La cola está vacía.</div>';
    return;
  }
  list.innerHTML = lastQueue.map((s, i) => {
    const st = statusLabel(s.status);
    return `
    <div class="song-row">
      <div class="song-idx">${i + 1}</div>
      <div class="song-info">
        <div class="song-title">${escapeHtml(s.displayName)}</div>
        <div class="song-meta">${escapeHtml(s.requestedByName)} · Mesa ${escapeHtml(s.table)} · <span class="pill ${st.cls}">${st.text}</span></div>
      </div>
      <div class="song-actions">
        ${s.status === 'queued' ? `
          <button class="btn-secondary btn-icon" onclick="reorder('${s.id}','up')">⬆️</button>
          <button class="btn-secondary btn-icon" onclick="reorder('${s.id}','down')">⬇️</button>
        ` : ''}
        <button class="btn-secondary btn-icon" onclick="openEdit('${s.id}','${escapeAttr(s.displayName)}')">✏️</button>
        <button class="btn-danger btn-icon" onclick="removeSong('${s.id}')">🗑️</button>
      </div>
    </div>`;
  }).join('');
}

async function removeSong(id) {
  try { await api(`/api/admin/songs/${id}`, { method: 'DELETE' }); showToast('Eliminada'); }
  catch (e) { showToast(e.message, true); }
}
async function reorder(id, direction) {
  try { await api(`/api/admin/songs/${id}/reorder`, { method: 'POST', body: JSON.stringify({ direction }) }); }
  catch (e) { showToast(e.message, true); }
}
function openEdit(id, currentName) {
  currentEditId = id;
  document.getElementById('editInput').value = currentName;
  document.getElementById('editModal').classList.add('show');
}
document.getElementById('editCancel').addEventListener('click', () => document.getElementById('editModal').classList.remove('show'));
document.getElementById('editSave').addEventListener('click', async () => {
  const displayName = document.getElementById('editInput').value.trim();
  if (!displayName) return showToast('El nombre no puede estar vacío', true);
  try {
    await api(`/api/admin/songs/${currentEditId}`, { method: 'PUT', body: JSON.stringify({ displayName }) });
    document.getElementById('editModal').classList.remove('show');
  } catch (e) { showToast(e.message, true); }
});

document.getElementById('btnPlay').addEventListener('click', async () => {
  try { await api('/api/admin/play', { method: 'POST' }); }
  catch (e) { showToast(e.message, true); }
});
document.getElementById('btnPause').addEventListener('click', async () => {
  try { await api('/api/admin/pause', { method: 'POST' }); }
  catch (e) { showToast(e.message, true); }
});
document.getElementById('btnNext').addEventListener('click', async () => {
  try { await api('/api/admin/next', { method: 'POST' }); }
  catch (e) { showToast(e.message, true); }
});
