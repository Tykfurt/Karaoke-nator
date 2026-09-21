const token = localStorage.getItem('karaoke_token');
if (!token) window.location.href = '/';

document.getElementById('who').textContent =
  `${localStorage.getItem('karaoke_name') || ''} · Mesa ${localStorage.getItem('karaoke_table') || ''}`;

document.getElementById('btnLogout').addEventListener('click', (e) => {
  e.preventDefault();
  localStorage.clear();
  window.location.href = '/';
});

let currentEditId = null;

async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json', 'x-token': token }, opts.headers || {});
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error inesperado');
  return data;
}

document.getElementById('btnAdd').addEventListener('click', async () => {
  const youtubeUrl = document.getElementById('youtubeUrl').value.trim();
  const displayName = document.getElementById('displayName').value.trim();
  if (!youtubeUrl) return showToast('Pega un link de YouTube', true);

  const btn = document.getElementById('btnAdd');
  btn.disabled = true;
  btn.textContent = 'Agregando...';
  try {
    await api('/api/songs', { method: 'POST', body: JSON.stringify({ youtubeUrl, displayName }) });
    document.getElementById('youtubeUrl').value = '';
    document.getElementById('displayName').value = '';
    showToast('¡Canción agregada a la cola! 🎉');
  } catch (e) {
    showToast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Agregar a la cola ➕';
  }
});

function render(queue) {
  const list = document.getElementById('queueList');
  if (!queue.length) {
    list.innerHTML = '<div class="empty">Aún no hay canciones. ¡Sé el primero! 🎶</div>';
    return;
  }
  list.innerHTML = queue.map((s, i) => {
    const st = statusLabel(s.status);
    const mine = s.requestedByName === localStorage.getItem('karaoke_name') && s.table === localStorage.getItem('karaoke_table');
    const isOwner = s.__isOwner;
    return `
    <div class="song-row">
      <div class="song-idx">${i + 1}</div>
      <div class="song-info">
        <div class="song-title">${escapeHtml(s.displayName)}</div>
        <div class="song-meta">${escapeHtml(s.requestedByName)} · Mesa ${escapeHtml(s.table)} · <span class="pill ${st.cls}">${st.text}</span></div>
      </div>
      ${isOwner && s.status === 'queued' ? `
      <div class="song-actions">
        <button class="btn-secondary btn-icon" onclick="openEdit('${s.id}','${escapeAttr(s.displayName)}')">✏️</button>
        <button class="btn-danger btn-icon" onclick="removeSong('${s.id}')">🗑️</button>
      </div>` : ''}
    </div>`;
  }).join('');
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(str) { return escapeHtml(str).replace(/'/g, '&#39;'); }

async function removeSong(id) {
  try {
    await api(`/api/songs/${id}`, { method: 'DELETE' });
    showToast('Canción eliminada');
  } catch (e) {
    showToast(e.message, true);
  }
}

function openEdit(id, currentName) {
  currentEditId = id;
  document.getElementById('editInput').value = currentName;
  document.getElementById('editModal').classList.add('show');
}
document.getElementById('editCancel').addEventListener('click', () => {
  document.getElementById('editModal').classList.remove('show');
});
document.getElementById('editSave').addEventListener('click', async () => {
  const displayName = document.getElementById('editInput').value.trim();
  if (!displayName) return showToast('El nombre no puede estar vacío', true);
  try {
    await api(`/api/songs/${currentEditId}`, { method: 'PUT', body: JSON.stringify({ displayName }) });
    document.getElementById('editModal').classList.remove('show');
    showToast('Nombre actualizado');
  } catch (e) {
    showToast(e.message, true);
  }
});

// Marcar cuáles canciones son mías comparando con /api/me
let myToken = token;
function tagOwnership(queue) {
  // El backend no expone el token de cada canción por privacidad,
  // así que identificamos "mío" por nombre+mesa (suficiente para esta app).
  const myName = localStorage.getItem('karaoke_name');
  const myTable = localStorage.getItem('karaoke_table');
  return queue.map(s => Object.assign({}, s, { __isOwner: s.requestedByName === myName && s.table === myTable }));
}

connectWS((msg) => {
  if (msg.type === 'queue_update') render(tagOwnership(msg.queue));
  if (msg.type === 'notice') showToast(msg.message, true);
});

// Carga inicial
api('/api/queue', { method: 'GET' }).then(({ queue }) => render(tagOwnership(queue))).catch(() => {});
