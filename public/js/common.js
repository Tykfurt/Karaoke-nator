function showToast(msg, isError) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => { t.className = 'toast'; }, 2400);
}

function connectWS(onMessage) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws;
  function connect() {
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (ev) => {
      try { onMessage(JSON.parse(ev.data)); } catch (e) { /* ignore */ }
    };
    ws.onclose = () => setTimeout(connect, 1500); // reconexión simple
  }
  connect();
  return () => ws;
}

function timeAgo() { return ''; }

function statusLabel(status) {
  if (status === 'queued') return { text: 'En cola', cls: 'pill-queued' };
  if (status === 'playing') return { text: '▶ Sonando', cls: 'pill-playing' };
  if (status === 'blocked') return { text: 'No disponible', cls: 'pill-blocked' };
  return { text: 'Reproducida', cls: 'pill-played' };
}
