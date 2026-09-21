let ytPlayer = null;
let ytReady = false;
let pendingVideoId = null;
let currentSongId = null;
let queueCache = [];

function onYouTubeIframeAPIReady() {
  ytPlayer = new YT.Player('player', {
    width: '100%', height: '100%',
    playerVars: {
      autoplay: 1, controls: 0, rel: 0, modestbranding: 1, playsinline: 1,
      origin: window.location.origin,
    },
    events: {
      onReady: () => {
        console.log('[karaoke] YouTube player listo (onReady)');
        ytReady = true;
        if (pendingVideoId) {
          const vid = pendingVideoId;
          pendingVideoId = null;
          showOverlay(false);
          ytPlayer.loadVideoById(vid);
        }
      },
      onStateChange: onPlayerStateChange,
      onError: (e) => {
        console.error('[karaoke] Error del reproductor de YouTube, código:', e.data);
        showOverlay(true, '⚠️ Ese video no se puede reproducir aquí. Saltando a la siguiente...');
        fetch('/api/player/error', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ songId: currentSongId, code: e.data })
        }).catch(() => {});
      },
    },
  });
}

console.log('[karaoke] player.js cargado, esperando a que YouTube API llame a onYouTubeIframeAPIReady...');

// Si el reproductor de YouTube tarda demasiado en inicializar (problema de
// internet en esta pantalla, o un bloqueador de anuncios/extensión), avisamos
// en vez de quedarnos con el mensaje de "esperando play" para siempre.
setTimeout(() => {
  if (!ytReady) {
    showOverlay(true, '⚠️ No se pudo cargar el reproductor de YouTube. Revisa la conexión a internet de esta pantalla, o si hay un bloqueador de anuncios activo.');
  }
}, 8000);

function onPlayerStateChange(event) {
  if (event.data === YT.PlayerState.ENDED) {
    fetch('/api/player/ended', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songId: currentSongId })
    }).catch(() => {});
  }
}

function showOverlay(show, text) {
  document.getElementById('overlay').style.display = show ? 'flex' : 'none';
  document.getElementById('player').style.display = show ? 'none' : 'block';
  if (text) document.getElementById('overlay').querySelector('p').textContent = text;
}

function loadVideo(videoId) {
  if (!ytReady) {
    pendingVideoId = videoId;
    showOverlay(true, 'Cargando reproductor de YouTube...');
    return;
  }
  showOverlay(false);
  ytPlayer.loadVideoById(videoId);
}

function updateNextUp() {
  const el = document.getElementById('nextUp');
  const upcoming = queueCache.filter(s => s.status === 'queued');
  if (!upcoming.length) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.textContent = `Siguiente: ${upcoming[0].displayName}`;
}

connectWS((msg) => {
  if (msg.type === 'queue_update') {
    queueCache = msg.queue;
    updateNextUp();
    if (!msg.player.isPlaying && !msg.player.currentSongId) {
      showOverlay(true, 'Esperando que el admin le dé play...');
    }
  }
  if (msg.type === 'player_command') {
    if (msg.action === 'load') {
      currentSongId = msg.songId;
      loadVideo(msg.videoId);
    } else if (msg.action === 'play') {
      if (ytReady) ytPlayer.playVideo();
    } else if (msg.action === 'pause') {
      if (ytReady) ytPlayer.pauseVideo();
    } else if (msg.action === 'stop') {
      currentSongId = null;
      if (ytReady) ytPlayer.stopVideo();
      showOverlay(true, '¡Cola terminada! Agrega más canciones 🎶');
    }
  }
});
