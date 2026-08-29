(() => {
  const socket = io();

  // --- Referencias del DOM ---
  const viewLanding = document.getElementById('view-landing');
  const viewRoom = document.getElementById('view-room');

  const formJoin = document.getElementById('form-join');
  const inputRoom = document.getElementById('input-room');
  const inputPassword = document.getElementById('input-password');
  const inputName = document.getElementById('input-name');
  const joinError = document.getElementById('join-error');

  const roomIdValue = document.getElementById('room-id-value');
  const syncOrb = document.getElementById('sync-orb');
  const userCountValue = document.getElementById('user-count-value');
  const btnCopyLink = document.getElementById('btn-copy-link');
  const btnLeave = document.getElementById('btn-leave');
  const copyToast = document.getElementById('copy-toast');

  const video = document.getElementById('video-player');
  const youtubeContainer = document.getElementById('youtube-player');
  const videoPlaceholder = document.getElementById('video-placeholder');
  const inputVideoUrl = document.getElementById('input-video-url');
  const btnLoadVideo = document.getElementById('btn-load-video');

  let currentRoomId = null;
  let isRemoteAction = false; // evita que un cambio remoto dispare un evento local en bucle

  // --- Soporte YouTube ---
  let playerMode = 'none'; // 'none' | 'direct' | 'youtube'
  let ytPlayer = null;
  let ytReady = false;
  let pendingYtLoad = null;

  function getYouTubeId(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\.|^m\./, '');
      if (host === 'youtu.be') {
        return u.pathname.slice(1).split('/')[0] || null;
      }
      if (host === 'youtube.com' || host === 'music.youtube.com') {
        if (u.pathname === '/watch') return u.searchParams.get('v');
        const shorts = u.pathname.match(/^\/shorts\/([^/?]+)/);
        if (shorts) return shorts[1];
        const embed = u.pathname.match(/^\/embed\/([^/?]+)/);
        if (embed) return embed[1];
      }
    } catch { /* no era una URL válida */ }
    return null;
  }

  window.onYouTubeIframeAPIReady = function () {
    ytReady = true;
    if (pendingYtLoad) {
      createYtPlayer(pendingYtLoad);
      pendingYtLoad = null;
    }
  };

  function createYtPlayer({ videoId, time, isPlaying }) {
    if (ytPlayer && ytPlayer.loadVideoById) {
      isRemoteAction = true;
      ytPlayer.loadVideoById(videoId, time || 0);
      if (!isPlaying) setTimeout(() => ytPlayer.pauseVideo(), 300);
      setTimeout(() => { isRemoteAction = false; }, 500);
      return;
    }
    ytPlayer = new YT.Player('youtube-player', {
      videoId,
      playerVars: { rel: 0, modestbranding: 1, playsinline: 1 },
      events: {
        onReady: (e) => {
          if (time) e.target.seekTo(time, true);
          if (isPlaying) e.target.playVideo(); else e.target.pauseVideo();
        },
        onStateChange: onYtStateChange
      }
    });
  }

  function onYtStateChange(e) {
    if (isRemoteAction || !window.YT) return;
    if (e.data === YT.PlayerState.PLAYING) {
      socket.emit('video-action', { action: 'play', time: ytPlayer.getCurrentTime() });
      updateOrb(true);
    } else if (e.data === YT.PlayerState.PAUSED) {
      socket.emit('video-action', { action: 'pause', time: ytPlayer.getCurrentTime() });
      updateOrb(false);
    }
  }

  // Cada pocos segundos, si hay algo reproduciéndose en YouTube, corrige el
  // desfasaje entre dispositivos (la API de YouTube no avisa cuando alguien
  // arrastra la barra de tiempo, así que esto compensa eso).
  setInterval(() => {
    if (isRemoteAction || playerMode !== 'youtube' || !ytPlayer || !ytPlayer.getPlayerState) return;
    if (ytPlayer.getPlayerState() === YT.PlayerState.PLAYING) {
      socket.emit('video-action', { action: 'sync', time: ytPlayer.getCurrentTime() });
    }
  }, 5000);

  // --- Prefill desde ?sala=mi-sala en la URL ---
  const params = new URLSearchParams(window.location.search);
  const salaParam = params.get('sala');
  if (salaParam) {
    inputRoom.value = salaParam;
    inputPassword.focus();
  } else {
    inputRoom.focus();
  }

  // ============================================================
  // Unirse / crear sala
  // ============================================================
  formJoin.addEventListener('submit', (e) => {
    e.preventDefault();
    joinError.textContent = '';

    const roomId = inputRoom.value.trim();
    const password = inputPassword.value;
    const displayName = inputName.value.trim() || 'Invitado';

    if (!roomId) return;

    socket.emit('join-room', { roomId, password, displayName });
  });

  socket.on('join-error', (message) => {
    joinError.textContent = message;
  });

  socket.on('joined-room', ({ roomId, state }) => {
    currentRoomId = roomId;
    roomIdValue.textContent = roomId;

    // Actualiza la URL para que se pueda compartir directamente (?sala=xxx)
    const url = new URL(window.location.href);
    url.searchParams.set('sala', roomId);
    window.history.replaceState({}, '', url);

    viewLanding.classList.add('hidden');
    viewRoom.classList.remove('hidden');

    applyRoomState(state);
  });

  function applyRoomState(state) {
    if (state.videoUrl) {
      setVideo(state.videoUrl, false, { time: state.currentTime || 0, isPlaying: state.isPlaying });
    }
    updateOrb(state.isPlaying);
  }

  // ============================================================
  // Contador de usuarios
  // ============================================================
  socket.on('user-count', (count) => {
    userCountValue.textContent = count;
  });

  // ============================================================
  // Cargar / cambiar video (detecta YouTube vs. link directo)
  // ============================================================
  function setVideo(url, announce, opts = {}) {
    const { time = 0, isPlaying = false } = opts;
    if (!url) return;

    videoPlaceholder.classList.add('hidden');
    const ytId = getYouTubeId(url);

    if (ytId) {
      playerMode = 'youtube';
      video.pause();
      video.removeAttribute('src');
      video.classList.add('hidden');
      youtubeContainer.classList.remove('hidden');

      if (ytReady) createYtPlayer({ videoId: ytId, time, isPlaying });
      else pendingYtLoad = { videoId: ytId, time, isPlaying };
    } else {
      playerMode = 'direct';
      if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
      youtubeContainer.classList.add('hidden');
      video.classList.remove('hidden');

      video.src = url;
      video.load();
      isRemoteAction = true;
      if (time) video.currentTime = time;
      if (isPlaying) video.play().catch(() => {});
      setTimeout(() => { isRemoteAction = false; }, 400);
    }

    if (announce) socket.emit('change-video', url);
  }

  btnLoadVideo.addEventListener('click', () => {
    const url = inputVideoUrl.value.trim();
    if (!url) return;
    setVideo(url, true);
  });

  inputVideoUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnLoadVideo.click();
  });

  socket.on('video-url-changed', (url) => {
    setVideo(url, false);
  });

  // ============================================================
  // Sincronización de Play / Pausa / Seek
  // ============================================================
  video.addEventListener('play', () => {
    if (isRemoteAction) return;
    socket.emit('video-action', { action: 'play', time: video.currentTime });
    updateOrb(true);
  });

  video.addEventListener('pause', () => {
    if (isRemoteAction) return;
    socket.emit('video-action', { action: 'pause', time: video.currentTime });
    updateOrb(false);
  });

  video.addEventListener('seeked', () => {
    if (isRemoteAction) return;
    socket.emit('video-action', { action: 'seek', time: video.currentTime });
    pulseOrb();
  });

  socket.on('video-action', ({ action, time }) => {
    isRemoteAction = true;

    const isYt = playerMode === 'youtube' && ytPlayer && ytPlayer.getCurrentTime;
    const getPos = () => (isYt ? ytPlayer.getCurrentTime() : video.currentTime);
    const setPos = (t) => { if (isYt) ytPlayer.seekTo(t, true); else video.currentTime = t; };

    if (Math.abs(getPos() - time) > 1) setPos(time);

    if (action === 'play') {
      if (isYt) ytPlayer.playVideo(); else video.play().catch(() => {});
      updateOrb(true);
    }
    if (action === 'pause') {
      if (isYt) ytPlayer.pauseVideo(); else video.pause();
      updateOrb(false);
    }
    if (action === 'seek' || action === 'sync') pulseOrb();

    setTimeout(() => { isRemoteAction = false; }, 500);
  });

  // ============================================================
  // El "orbe de sincronía" — feedback visual del estado compartido
  // ============================================================
  function updateOrb(isPlaying) {
    syncOrb.classList.remove('playing', 'paused');
    syncOrb.classList.add(isPlaying ? 'playing' : 'paused');
    pulseOrb();
  }

  function pulseOrb() {
    syncOrb.classList.remove('pulse');
    void syncOrb.offsetWidth; // fuerza reflow para poder repetir la animación
    syncOrb.classList.add('pulse');
  }

  // ============================================================
  // Copiar link de invitación / Salir de la sala
  // ============================================================
  btnCopyLink.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
    } catch {
      // Fallback por si el navegador bloquea la Clipboard API
      const tmp = document.createElement('input');
      tmp.value = window.location.href;
      document.body.appendChild(tmp);
      tmp.select();
      document.execCommand('copy');
      document.body.removeChild(tmp);
    }
    copyToast.classList.remove('hidden');
    setTimeout(() => copyToast.classList.add('hidden'), 1800);
  });

  btnLeave.addEventListener('click', () => {
    window.location.href = window.location.pathname;
  });
})();
