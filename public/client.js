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
  const videoPlaceholder = document.getElementById('video-placeholder');
  const inputVideoUrl = document.getElementById('input-video-url');
  const btnLoadVideo = document.getElementById('btn-load-video');

  let currentRoomId = null;
  let isRemoteAction = false; // evita que un cambio remoto dispare un evento local en bucle

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
      loadVideoSrc(state.videoUrl, false);
      isRemoteAction = true;
      video.currentTime = state.currentTime || 0;
      if (state.isPlaying) video.play().catch(() => {});
      setTimeout(() => { isRemoteAction = false; }, 400);
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
  // Cargar / cambiar video
  // ============================================================
  function loadVideoSrc(url, announce) {
    video.src = url;
    video.load();
    videoPlaceholder.classList.toggle('hidden', !!url);
    if (announce) socket.emit('change-video', url);
  }

  btnLoadVideo.addEventListener('click', () => {
    const url = inputVideoUrl.value.trim();
    if (!url) return;
    loadVideoSrc(url, true);
  });

  inputVideoUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnLoadVideo.click();
  });

  socket.on('video-url-changed', (url) => {
    loadVideoSrc(url, false);
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

    if (Math.abs(video.currentTime - time) > 0.6) {
      video.currentTime = time;
    }

    if (action === 'play') { video.play().catch(() => {}); updateOrb(true); }
    if (action === 'pause') { video.pause(); updateOrb(false); }
    if (action === 'seek') pulseOrb();

    setTimeout(() => { isRemoteAction = false; }, 400);
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
