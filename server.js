// ============================================================
//  KARAOKE-INADOR — Servidor principal
//  Express (REST + estáticos) + ws (tiempo real) + qrcode
// ============================================================
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ---------- Configuración ----------
const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';

// Cuando el proyecto está empaquetado con pkg, __dirname apunta al
// snapshot virtual (solo lectura). Los archivos que necesitamos
// escribir (data.json) deben ir junto al .exe real.
const isPkg = typeof process.pkg !== 'undefined';
const BASE_DIR = isPkg ? path.dirname(process.execPath) : __dirname;
const DATA_FILE = path.join(BASE_DIR, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- Estado en memoria ----------
/**
 * users: { [token]: { token, name, table, createdAt } }
 * songs: [{ id, videoId, title, displayName, requestedBy, requestedByName,
 *           table, status: 'queued'|'playing'|'played', order, addedAt }]
 * player: { isPlaying: bool, currentSongId: string|null }
 */
let db = {
  users: {},
  songs: [],
  player: { isPlaying: false, currentSongId: null },
};

// ---------- Túnel a internet (Cloudflare Tunnel, opcional) ----------
// Si existe un binario "cloudflared" (junto al .exe o en el PATH del sistema),
// lo levantamos automáticamente para exponer el servidor con una URL pública
// tipo https://algo.trycloudflare.com. Si no existe, la app sigue funcionando
// 100% en red local sin ningún problema.
let PUBLIC_URL = null;
let tunnelProcess = null;
let tunnelError = null;

function startTunnel() {
  const binName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const localBinPath = path.join(BASE_DIR, binName);
  const cmd = fs.existsSync(localBinPath) ? localBinPath : 'cloudflared';

  try {
    tunnelProcess = spawn(cmd, ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log('   Intentando iniciar túnel con: ' + cmd);
  } catch (e) {
    tunnelError = 'No se encontró cloudflared: ' + e.message;
    console.log('ℹ️  ' + tunnelError);
    return;
  }

  const urlRegex = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;
  const onData = (data) => {
    const text = data.toString();
    const match = text.match(urlRegex);
    if (match && !PUBLIC_URL) {
      PUBLIC_URL = match[0];
      console.log('🌍 Acceso por internet activo: ' + PUBLIC_URL);
    }
  };
  tunnelProcess.stdout.on('data', onData);
  tunnelProcess.stderr.on('data', onData);
  tunnelProcess.on('error', (err) => {
    tunnelError = 'No se pudo iniciar cloudflared: ' + err.message;
    console.log('ℹ️  ' + tunnelError);
    console.log('   Verifica que cloudflared.exe esté junto a este archivo y se llame exactamente así.');
    tunnelProcess = null;
  });
  tunnelProcess.on('exit', () => {
    PUBLIC_URL = null;
    tunnelProcess = null;
  });
}

// Cloudflare Tunnel agrega el header "cf-connecting-ip" (o "cf-ray") a todo
// tráfico que llega por la URL pública. El tráfico de la red local (Wi-Fi)
// nunca pasa por Cloudflare, así que nunca trae ese header. Con esto
// distinguimos con certeza si una petición vino de internet o de la LAN,
// sin importar si además se accede por "localhost" en el propio PC.
function isRemoteRequest(req) {
  return Boolean(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
}

function localOnly(req, res, next) {
  if (isRemoteRequest(req)) {
    return res
      .status(403)
      .send(
        '<html><body style="background:#12081f;color:#fff;font-family:sans-serif;' +
          'text-align:center;padding:60px 20px"><h2>🚫 Sección solo local</h2>' +
          '<p>Esta página solo está disponible desde la red Wi-Fi del evento.</p></body></html>'
      );
  }
  next();
}

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      db = Object.assign(db, parsed);
      // Al reiniciar el server, ninguna canción queda "sonando" de verdad
      // (la pantalla del player empieza en blanco), así que limpiamos
      // cualquier estado de reproducción que haya quedado guardado.
      db.player.isPlaying = false;
      db.player.currentSongId = null;
      db.songs.forEach((s) => { if (s.status === 'playing') s.status = 'queued'; });
    }
  } catch (e) {
    console.error('No se pudo leer data.json, se empieza de cero.', e.message);
  }
}

let saveTimeout = null;
function saveData() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2), (err) => {
      if (err) console.error('Error guardando data.json:', err.message);
    });
  }, 150); // debounce simple
}

loadData();

// ---------- App / servidor HTTP / WebSocket ----------
const app = express();
app.use(express.json());

// admin.html y player.html solo se sirven si la petición NO viene del túnel
// público. Se declaran antes de express.static para que tengan prioridad.
app.get('/admin.html', localOnly, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/player.html', localOnly, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'player.html')));

app.use(express.static(PUBLIC_DIR));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}

function publicQueue() {
  // No exponemos el token de quién pidió la canción, solo el nombre.
  return db.songs.map((s) => ({
    id: s.id,
    videoId: s.videoId,
    title: s.title,
    displayName: s.displayName,
    requestedByName: s.requestedByName,
    table: s.table,
    status: s.status,
    addedAt: s.addedAt,
  }));
}

function broadcastQueue() {
  broadcast({ type: 'queue_update', queue: publicQueue(), player: db.player });
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'queue_update', queue: publicQueue(), player: db.player }));
});

// ---------- Utilidades ----------
function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) {
      return u.pathname.slice(1);
    }
    if (u.hostname.includes('youtube.com')) {
      if (u.pathname === '/watch') return u.searchParams.get('v');
      if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2];
      if (u.pathname.startsWith('/live/')) return u.pathname.split('/')[2];
      if (u.pathname.startsWith('/embed/')) return u.pathname.split('/')[2];
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchTitle(videoId) {
  try {
    const resp = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
    );
    if (!resp.ok) return 'Canción sin título';
    const data = await resp.json();
    return data.title || 'Canción sin título';
  } catch {
    return 'Canción sin título';
  }
}

function getLocalIPs() {
  const nets = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) results.push(net.address);
    }
  }
  return results;
}

function requireUser(req, res, next) {
  const token = req.headers['x-token'] || req.body.token || req.query.token;
  const user = token && db.users[token];
  if (!user) return res.status(401).json({ error: 'Usuario no válido. Regístrate de nuevo.' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const pin = req.headers['x-admin-pin'] || req.body.pin || req.query.pin;
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'PIN de administrador incorrecto.' });
  next();
}

function nextQueuedSong() {
  return db.songs.find((s) => s.status === 'queued');
}

function loadSongToPlayer(song) {
  if (!song) {
    db.player.currentSongId = null;
    db.player.isPlaying = false;
    broadcast({ type: 'player_command', action: 'stop' });
    broadcastQueue();
    return;
  }
  song.status = 'playing';
  db.player.currentSongId = song.id;
  db.player.isPlaying = true;
  saveData();
  broadcast({ type: 'player_command', action: 'load', videoId: song.videoId, songId: song.id });
  broadcastQueue();
}

// ============================================================
//  API — Usuarios
// ============================================================
app.post('/api/register', (req, res) => {
  const { name, table } = req.body;
  if (!name || !table) return res.status(400).json({ error: 'Nombre y número de mesa son obligatorios.' });
  const token = crypto.randomUUID();
  db.users[token] = { token, name: String(name).trim(), table: String(table).trim(), createdAt: Date.now() };
  saveData();
  res.json({ token, name: db.users[token].name, table: db.users[token].table });
});

app.get('/api/me', requireUser, (req, res) => {
  res.json(req.user);
});

// ============================================================
//  API — Cola de canciones (usuarios)
// ============================================================
app.get('/api/queue', (req, res) => {
  res.json({ queue: publicQueue(), player: db.player });
});

app.post('/api/songs', requireUser, async (req, res) => {
  const { youtubeUrl, displayName } = req.body;
  const videoId = extractVideoId(youtubeUrl || '');
  if (!videoId) return res.status(400).json({ error: 'Ese link de YouTube no parece válido.' });

  const title = await fetchTitle(videoId);
  const song = {
    id: crypto.randomUUID(),
    videoId,
    title,
    displayName: (displayName && displayName.trim()) || title,
    requestedBy: req.user.token,
    requestedByName: req.user.name,
    table: req.user.table,
    status: 'queued',
    addedAt: Date.now(),
  };
  db.songs.push(song);
  saveData();
  broadcastQueue();
  res.json(song);
});

app.put('/api/songs/:id', requireUser, (req, res) => {
  const song = db.songs.find((s) => s.id === req.params.id);
  if (!song) return res.status(404).json({ error: 'Canción no encontrada.' });
  if (song.requestedBy !== req.user.token) return res.status(403).json({ error: 'Esta canción no es tuya.' });
  if (song.status !== 'queued') return res.status(400).json({ error: 'No puedes editar una canción que ya se reprodujo o está sonando.' });

  const { displayName } = req.body;
  if (displayName && displayName.trim()) song.displayName = displayName.trim();
  saveData();
  broadcastQueue();
  res.json(song);
});

app.delete('/api/songs/:id', requireUser, (req, res) => {
  const song = db.songs.find((s) => s.id === req.params.id);
  if (!song) return res.status(404).json({ error: 'Canción no encontrada.' });
  if (song.requestedBy !== req.user.token) return res.status(403).json({ error: 'Esta canción no es tuya.' });
  if (song.status === 'playing') return res.status(400).json({ error: 'No puedes borrar la canción que está sonando ahora.' });

  db.songs = db.songs.filter((s) => s.id !== req.params.id);
  saveData();
  broadcastQueue();
  res.json({ ok: true });
});

// ============================================================
//  API — Admin (todo bajo /api/admin requiere estar en red local)
// ============================================================
app.use('/api/admin', localOnly);

app.get('/api/admin/tunnel-status', (req, res) => {
  res.json({ active: Boolean(PUBLIC_URL), url: PUBLIC_URL, error: tunnelError });
});

app.post('/api/admin/login', (req, res) => {
  const { pin } = req.body;
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'PIN incorrecto.' });
  res.json({ ok: true });
});

app.get('/api/admin/qr', async (req, res) => {
  const mode = req.query.mode || 'local';
  let url;
  if (mode === 'public') {
    if (!PUBLIC_URL) return res.status(400).json({ error: 'El acceso por internet no está activo.' });
    url = PUBLIC_URL + '/';
  } else {
    const ip = req.query.ip || getLocalIPs()[0] || 'localhost';
    url = `http://${ip}:${PORT}/`;
  }
  const dataUrl = await QRCode.toDataURL(url, { width: 320, margin: 1 });
  res.json({ url, dataUrl });
});

app.get('/api/admin/ips', (req, res) => {
  res.json({ ips: getLocalIPs(), port: PORT });
});

app.put('/api/admin/songs/:id', requireAdmin, (req, res) => {
  const song = db.songs.find((s) => s.id === req.params.id);
  if (!song) return res.status(404).json({ error: 'Canción no encontrada.' });
  const { displayName } = req.body;
  if (displayName && displayName.trim()) song.displayName = displayName.trim();
  saveData();
  broadcastQueue();
  res.json(song);
});

app.delete('/api/admin/songs/:id', requireAdmin, (req, res) => {
  const song = db.songs.find((s) => s.id === req.params.id);
  if (!song) return res.status(404).json({ error: 'Canción no encontrada.' });
  if (song.id === db.player.currentSongId) {
    db.player.currentSongId = null;
    db.player.isPlaying = false;
    broadcast({ type: 'player_command', action: 'stop' });
  }
  db.songs = db.songs.filter((s) => s.id !== req.params.id);
  saveData();
  broadcastQueue();
  res.json({ ok: true });
});

// Reordenar (mover canción arriba/abajo en la cola)
app.post('/api/admin/songs/:id/reorder', requireAdmin, (req, res) => {
  const { direction } = req.body; // 'up' | 'down'
  const idx = db.songs.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrada.' });
  const swapWith = direction === 'up' ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= db.songs.length) return res.json({ ok: true });
  [db.songs[idx], db.songs[swapWith]] = [db.songs[swapWith], db.songs[idx]];
  saveData();
  broadcastQueue();
  res.json({ ok: true });
});

app.post('/api/admin/play', requireAdmin, (req, res) => {
  // Siempre mandamos la orden completa de "cargar" (con videoId incluido),
  // en vez de un simple "reanudar" — así funciona aunque la pantalla del
  // player se haya refrescado y no tenga nada cargado en memoria.
  let song = db.songs.find((s) => s.id === db.player.currentSongId);
  if (!song) song = nextQueuedSong();
  if (!song) return res.status(400).json({ error: 'No hay canciones en la cola.' });
  loadSongToPlayer(song);
  res.json({ ok: true });
});

app.post('/api/admin/pause', requireAdmin, (req, res) => {
  db.player.isPlaying = false;
  broadcast({ type: 'player_command', action: 'pause' });
  saveData();
  broadcastQueue();
  res.json({ ok: true });
});

app.post('/api/admin/next', requireAdmin, (req, res) => {
  const current = db.songs.find((s) => s.id === db.player.currentSongId);
  if (current) current.status = 'played';
  const next = nextQueuedSong();
  loadSongToPlayer(next || null);
  saveData();
  res.json({ ok: true });
});

// El player (pantalla/TV) avisa cuando un video terminó — solo local
app.post('/api/player/ended', localOnly, (req, res) => {
  const { songId } = req.body;
  const song = db.songs.find((s) => s.id === songId);
  if (song) song.status = 'played';
  const next = nextQueuedSong();
  if (db.player.isPlaying) {
    loadSongToPlayer(next || null);
  } else {
    db.player.currentSongId = null;
  }
  saveData();
  res.json({ ok: true });
});

// El player avisa cuando YouTube rechaza reproducir un video embebido
// (dueño del video desactivó la reproducción embebida: códigos 101/150).
// Marcamos la canción como "bloqueada", avisamos y pasamos a la siguiente sola.
app.post('/api/player/error', localOnly, (req, res) => {
  const { songId, code } = req.body;
  const song = db.songs.find((s) => s.id === songId);
  if (song) song.status = 'blocked';
  broadcast({
    type: 'notice',
    message: song
      ? `"${song.displayName}" no se puede reproducir aquí (bloqueada por YouTube, código ${code}). Se saltó automáticamente.`
      : `Un video no se pudo reproducir (código ${code}). Se saltó automáticamente.`,
  });
  const next = nextQueuedSong();
  if (db.player.isPlaying) {
    loadSongToPlayer(next || null);
  } else {
    db.player.currentSongId = null;
  }
  saveData();
  res.json({ ok: true });
});

// ============================================================
//  Arranque
// ============================================================
server.listen(PORT, () => {
  const ips = getLocalIPs();
  console.log('========================================');
  console.log('   KARAOKE-INADOR corriendo!');
  console.log('   Panel admin: http://localhost:' + PORT + '/admin.html');
  console.log('   Pantalla/TV: http://localhost:' + PORT + '/player.html');
  if (ips.length) {
    console.log('   Invitados en la MISMA Wi-Fi entran a:');
    ips.forEach((ip) => console.log('     http://' + ip + ':' + PORT + '/'));
  }
  console.log('   PIN de administrador: ' + ADMIN_PIN);
  console.log('   Buscando cloudflared para habilitar acceso por internet...');
  console.log('========================================');
  startTunnel();
});
