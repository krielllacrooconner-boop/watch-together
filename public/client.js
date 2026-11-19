(() => {
  'use strict';

  // ============================================================
  // SyncRoom — cliente
  // El servidor manda un "tick" por segundo con la posición exacta.
  // Acá solo corregimos la deriva local: nunca mandamos nuestra
  // posición de forma periódica (eso era lo que rompía la sync).
  // ============================================================

  const $ = (id) => document.getElementById(id);
  const STORE_KEY = 'syncroom:join:v2';

  const el = {
    landing: $('view-landing'), room: $('view-room'),
    formJoin: $('form-join'), inputRoom: $('input-room'), inputPassword: $('input-password'),
    inputName: $('input-name'), joinError: $('join-error'), btnRandom: $('btn-random-room'),
    banner: $('connection-banner'),

    roomId: $('room-id-value'), orb: $('sync-orb'), status: $('sync-status'),
    avatars: $('avatars'), userCount: $('user-count-value'),
    btnSync: $('btn-sync'), btnFullscreen: $('btn-fullscreen'), btnTheater: $('btn-theater'),
    btnCopy: $('btn-copy-link'), btnLeave: $('btn-leave'), toast: $('copy-toast'),

    video: $('video-player'), ytBox: $('youtube-player'), ytTarget: $('yt-target'), placeholder: $('video-placeholder'),
    loading: $('video-loading'), loadingText: $('loading-text'),
    failure: $('video-error'), errorText: $('error-text'),
    retry: $('btn-retry'), errorCopy: $('btn-error-copy'),
    unlock: $('play-unlock'), fsHint: $('fs-hint'), source: $('video-source'),
    urlInput: $('input-video-url'), loadBtn: $('btn-load-video'),

    chatPanel: $('chat-panel'), chatMessages: $('chat-messages'),
    chatForm: $('chat-form'), chatInput: $('chat-input'), chatToggle: $('btn-chat-toggle')
  };

  const socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 4000,
    timeout: 10000
  });

  // --- Estado ---
  let joinInfo = null;
  let currentRoomId = null;
  let myName = 'Invitado';
  let myId = null;
  let isHost = false;

  let videoMode = 'none'; // none | file | hls | direct | youtube
  let currentVideo = null; // { type, url, id? }
  let mediaReady = false;
  let ytPlayer = null;
  let ytState = null;
  let ytApiReady = false;
  let pendingYt = null;
  let hls = null;

  let pending = null; // { target, playing, rate } mientras el media no está listo
  let latestPlayback = { position: 0, playing: false, rate: 1, sentAt: Date.now() };
  let expectedPlaying = false;
  let suppressUntil = 0;
  let buffering = false;
  let started = false;

  let nudgeTimer = null;
  let nudgeActive = false;
  let unlockWatch = null;
  let statusTimer = null;
  let toastTimer = null;
  let uiTimer = null;
  let hintTimer = null;

  let theater = false;
  let fullscreenActive = false;

  // ------------------------------------------------------------
  // Utilidades
  // ------------------------------------------------------------
  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

  function show(node) { node.classList.remove('hidden'); }
  function hide(node) { node.classList.add('hidden'); }

  function showLoading(on, text) {
    if (text) el.loadingText.textContent = text;
    el.loading.classList.toggle('hidden', !on);
    if (on) hide(el.failure);
  }
  function showError(text) {
    hide(el.loading);
    hide(el.unlock);
    el.errorText.textContent = text || 'No se pudo cargar el video. Probá con otro link.';
    show(el.failure);
    setStatus('Error de video', 'bad');
  }
  function hideError() { hide(el.failure); }

  function showUnlock(on) {
    if (on) {
      showLoading(false);
      hideError();
      show(el.unlock);
      setStatus('Tocá para sincronizar', 'warn');
    } else {
      hide(el.unlock);
    }
  }

  function toast(text) {
    el.toast.textContent = text;
    show(el.toast);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => hide(el.toast), 1900);
  }

  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.className = 'sync-status' + (kind ? ' ' + kind : '');
  }

  function pulseOrb() {
    el.orb.classList.remove('pulse');
    void el.orb.offsetWidth;
    el.orb.classList.add('pulse');
  }
  function updateOrb(playing) {
    el.orb.classList.remove('playing', 'paused');
    el.orb.classList.add(playing ? 'playing' : 'paused');
  }

  function initials(name) {
    return String(name || '?').trim().slice(0, 2).toUpperCase();
  }

  // ------------------------------------------------------------
  // Reloj / posición
  // ------------------------------------------------------------
  function computeTarget(p) {
    const age = Math.max(0, Date.now() - (p && p.sentAt ? p.sentAt : Date.now()));
    return Math.max(0, (p && p.position ? p.position : 0) + (p && p.playing ? (age / 1000) * (p.rate || 1) : 0));
  }

  function suppressed() { return Date.now() < suppressUntil; }

  function isYoutube() { return videoMode === 'youtube' && ytPlayer && typeof ytPlayer.getCurrentTime === 'function'; }

  function isReady() {
    if (videoMode === 'youtube') {
      return !!(ytPlayer && typeof ytPlayer.getCurrentTime === 'function' && ytState !== null && ytState !== -1);
    }
    return videoMode !== 'none' && mediaReady;
  }

  function isPlayingLocally() {
    if (isYoutube()) return !!(window.YT && ytState === YT.PlayerState.PLAYING);
    return !!el.video.src && !el.video.paused && !el.video.ended;
  }

  function mediaCanPlay() {
    if (isYoutube()) {
      if (!window.YT) return false;
      return ytState !== null && ytState !== YT.PlayerState.BUFFERING && ytState !== YT.PlayerState.UNSTARTED;
    }
    return el.video.readyState >= 2;
  }

  function getPosition() {
    if (isYoutube()) {
      const t = ytPlayer.getCurrentTime();
      return Number.isFinite(t) ? t : 0;
    }
    return Number.isFinite(el.video.currentTime) ? el.video.currentTime : 0;
  }

  function setPosition(seconds) {
    const t = Math.max(0, Number(seconds) || 0);
    try {
      if (isYoutube()) ytPlayer.seekTo(t, true);
      else el.video.currentTime = Number.isFinite(el.video.duration) ? Math.min(t, el.video.duration) : t;
    } catch { /* media todavía no acepta seeks */ }
  }

  function ytRate(rate) {
    const options = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
    return options.reduce((best, r) => Math.abs(r - rate) < Math.abs(best - rate) ? r : best, 1);
  }

  function setRate(rate) {
    const r = clamp(Number(rate) || 1, 0.5, 2);
    try {
      if (isYoutube()) ytPlayer.setPlaybackRate(ytRate(r));
      else if (videoMode !== 'youtube') el.video.playbackRate = r;
    } catch { /* algunos navegadores limitan la velocidad */ }
  }

  function getRate() {
    try {
      if (isYoutube() && ytPlayer.getPlaybackRate) return ytPlayer.getPlaybackRate() || 1;
    } catch { /* ignore */ }
    return el.video.playbackRate || 1;
  }

  function nudge(diff, baseRate) {
    nudgeActive = true;
    const rate = clamp(1 + diff * 0.12, 0.85, 1.15);
    suppressUntil = Date.now() + 200;
    setRate(rate);
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => {
      suppressUntil = Date.now() + 200;
      setRate(baseRate || 1);
      nudgeActive = false;
    }, 1400);
  }

  // ------------------------------------------------------------
  // Reproducción local (sin mandar eventos propios al servidor)
  // ------------------------------------------------------------
  function safePlay() {
    if (isPlayingLocally()) return;
    try {
      const result = el.video.play();
      if (result && result.catch) {
        result.catch((err) => {
          if (!currentVideo || videoMode === 'youtube') return;
          if (err && err.name === 'NotAllowedError') showUnlock(true);
          else if (err && err.name === 'NotSupportedError') showError('Este formato no es compatible con tu navegador.');
          else showLoading(true, 'Esperando el video…');
        });
      }
    } catch { showUnlock(true); }
  }

  function safeYtPlay() {
    if (!ytPlayer || !ytPlayer.playVideo) return;
    try { ytPlayer.unMute(); ytPlayer.playVideo(); } catch { /* ignore */ }
    clearTimeout(unlockWatch);
    unlockWatch = setTimeout(() => {
      if (expectedPlaying && window.YT && ytState !== YT.PlayerState.PLAYING) showUnlock(true);
    }, 2500);
  }

  function playLocal() {
    if (isYoutube()) safeYtPlay();
    else safePlay();
  }

  function pauseLocal() {
    hideUnlock();
    try { if (isYoutube()) ytPlayer.pauseVideo(); else el.video.pause(); } catch { /* ignore */ }
  }

  function emitCommand(action, time) {
    if (!currentRoomId) return;
    const payload = { action, time: Number.isFinite(time) ? time : getPosition() };
    if (action === 'rate') payload.rate = getRate();
    socket.emit('playback:command', payload);
  }

  function reportPeer() {
    if (!currentRoomId) return;
    socket.emit('peer:state', {
      buffering: !!buffering,
      synced: !!(started || !expectedPlaying)
    });
  }

  // ------------------------------------------------------------
  // Aplicar estado remoto
  // ------------------------------------------------------------
  function applyPlayback(p, action) {
    if (!p) return;
    const target = computeTarget(p);
    latestPlayback = p;
    expectedPlaying = !!p.playing;
    updateOrb(p.playing);

    if (!isReady()) {
      pending = { target, playing: p.playing, rate: p.rate || 1 };
      return;
    }

    suppressUntil = Date.now() + 900;
    clearTimeout(nudgeTimer);
    nudgeActive = false;

    if (Math.abs(getPosition() - target) > 0.6) setPosition(target);
    setRate(p.rate || 1);

    if (p.playing) {
      if (!mediaCanPlay()) showUnlock(true);
      else playLocal();
    } else {
      pauseLocal();
      showLoading(false);
    }

    if (action === 'seek' || action === 'sync') pulseOrb();
  }

  function onTick(p) {
    if (!p) return;
    const target = computeTarget(p);
    latestPlayback = p;
    expectedPlaying = !!p.playing;
    updateOrb(p.playing);

    if (!isReady()) {
      pending = { target, playing: p.playing, rate: p.rate || 1 };
      return;
    }

    // Autoplay bloqueado: no seguimos corrigiendo hasta que la persona toque.
    if (p.playing && !isPlayingLocally()) {
      if (!el.unlock.classList.contains('hidden')) return;
      if (mediaCanPlay()) playLocal();
      else showUnlock(true);
      return;
    }
    if (!p.playing && isPlayingLocally()) {
      suppressUntil = Date.now() + 700;
      pauseLocal();
      return;
    }

    const diff = target - getPosition();
    const distance = Math.abs(diff);

    if (distance > 1.2) {
      // Salto grande: seek directo al reloj del servidor.
      suppressUntil = Date.now() + 750;
      setPosition(target);
      pulseOrb();
      if (distance > 4) {
        setStatus('Ajustando…', 'warn');
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => setStatus('Sincronizado', 'ok'), 1000);
      }
    } else if (p.playing && distance > 0.35 && !buffering && !nudgeActive) {
      // Desfasaje chico: aceleramos/frenamos un poco sin salto visible.
      nudge(diff, p.rate || 1);
    }

    if (!nudgeActive && Math.abs(getRate() - (p.rate || 1)) > 0.01) {
      suppressUntil = Date.now() + 200;
      setRate(p.rate || 1);
    }
  }

  // ------------------------------------------------------------
  // Fuentes de video
  // ------------------------------------------------------------
  function sourceLabel(info) {
    if (!info) return 'Sin video';
    if (info.type === 'youtube') return 'YouTube · HD';
    if (info.type === 'hls') return 'HLS · adaptativo';
    if (info.type === 'file') return 'Video directo';
    const ext = (info.url.split(/[?#]/)[0].split('.').pop() || 'stream').slice(0, 4).toUpperCase();
    return 'Video · ' + ext;
  }

  function destroyHls() {
    if (hls) { try { hls.destroy(); } catch { /* ignore */ } hls = null; }
  }

  function clearVideo() {
    destroyHls();
    clearTimeout(unlockWatch);
    videoMode = 'none';
    currentVideo = null;
    mediaReady = false;
    started = false;
    try { el.video.pause(); el.video.removeAttribute('src'); el.video.load(); } catch { /* ignore */ }
    el.video.classList.add('hidden');
    el.ytBox.classList.add('hidden');
    el.ytBox.innerHTML = '<div id="yt-target"></div>';
    el.ytTarget = $('yt-target');
    show(el.placeholder);
    hide(el.loading);
    hide(el.failure);
    hide(el.unlock);
    el.source.textContent = 'Sin video';
  }

  function applySource(info, p, force) {
    if (!info) { clearVideo(); return; }

    const same = !force && currentVideo && currentVideo.url === info.url && currentVideo.type === info.type &&
      ((videoMode === 'youtube' && ytPlayer) || (videoMode !== 'youtube' && mediaReady));

    currentVideo = info;
    hide(el.placeholder);
    hideError();
    hide(el.unlock);
    el.source.textContent = sourceLabel(info);

    if (same) {
      applyPlayback(p || latestPlayback);
      return;
    }

    started = false;
    mediaReady = false;
    const initialTarget = computeTarget(p || latestPlayback);
    pending = { target: initialTarget, playing: !!(p && p.playing), rate: (p && p.rate) || 1 };
    expectedPlaying = !!pending.playing;
    latestPlayback = p || latestPlayback;
    suppressUntil = Date.now() + 1200;
    updateOrb(expectedPlaying);
    buffering = false;
    reportPeer();

    if (info.type === 'youtube') setupYoutube(info, pending);
    else setupDirect(info, pending);
  }

  function setupDirect(info, p) {
    videoMode = info.type;
    destroyHls();
    clearTimeout(unlockWatch);
    try { if (ytPlayer && ytPlayer.destroy) ytPlayer.destroy(); } catch { /* ignore */ }
    ytPlayer = null;
    ytState = null;

    el.ytBox.classList.add('hidden');
    el.ytBox.innerHTML = '<div id="yt-target"></div>';
    el.ytTarget = $('yt-target');
    el.video.classList.remove('hidden');
    el.video.controls = true;
    showLoading(true, info.type === 'hls' ? 'Conectando con el stream…' : 'Preparando video…');

    if (info.type === 'hls' && window.Hls && Hls.isSupported()) {
      let recovered = 0;
      hls = new Hls({
        enableWorker: true,
        capLevelToPlayerSize: true,
        maxBufferLength: 30,
        backBufferLength: 60,
        startLevel: -1
      });
      hls.loadSource(info.url);
      hls.attachMedia(el.video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        showLoading(false);
        el.source.textContent = 'HLS · adaptativo';
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data || !data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recovered < 2) {
          recovered += 1;
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recovered < 2) {
          recovered += 1;
          hls.recoverMediaError();
        } else {
          showError('El stream no responde. Probá con otro link o reintentá.');
        }
      });
    } else {
      // Safari reproduce HLS nativamente; los demás, archivos directos.
      el.video.src = info.url;
      el.video.load();
    }
  }

  function isYtApiReady() { return !!(window.YT && window.YT.Player); }

  function setupYoutube(info, p) {
    videoMode = 'youtube';
    mediaReady = false;
    try { el.video.pause(); el.video.removeAttribute('src'); el.video.load(); } catch { /* ignore */ }
    el.video.classList.add('hidden');
    el.ytBox.classList.remove('hidden');
    showLoading(true, 'Cargando YouTube…');

    const options = { videoId: info.id, position: p.target || 0, playing: p.playing, rate: p.rate || 1 };

    if (!isYtApiReady()) {
      pendingYt = options;
      setTimeout(() => {
        if (pendingYt && !isYtApiReady()) {
          showError('No se pudo conectar con YouTube. Revisá tu conexión y reintentá.');
        }
      }, 9000);
      return;
    }
    createYt(options);
  }

  function createYt(options) {
    try { if (ytPlayer && ytPlayer.destroy) ytPlayer.destroy(); } catch { /* ignore */ }
    ytPlayer = null;
    ytState = null;
    el.ytBox.innerHTML = '<div id="yt-target"></div>';
    el.ytTarget = $('yt-target');

    ytPlayer = new YT.Player(el.ytTarget, {
      videoId: options.videoId,
      playerVars: {
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        iv_load_policy: 3,
        enablejsapi: 1,
        origin: window.location.origin
      },
      events: {
        onReady: (event) => {
          ytState = YT.PlayerState.UNSTARTED;
          suppressUntil = Date.now() + 1200;
          hideError();
          showLoading(false);
          try { event.target.setPlaybackRate(ytRate(options.rate || 1)); } catch { /* ignore */ }
          if (options.position > 0) event.target.seekTo(options.position, true);
          if (options.playing) playLocal(); else event.target.pauseVideo();
          reportPeer();
        },
        onStateChange: (event) => {
          ytState = event.data;
          if (event.data === YT.PlayerState.PLAYING) {
            started = true;
            clearTimeout(unlockWatch);
            hide(el.unlock);
            showLoading(false);
            buffering = false;
            reportPeer();
            updateOrb(true);
            if (suppressed() && expectedPlaying) { /* eco del comando remoto */ }
            else emitCommand('play', ytPlayer.getCurrentTime());
          } else if (event.data === YT.PlayerState.PAUSED) {
            showLoading(false);
            buffering = false;
            reportPeer();
            updateOrb(false);
            if (suppressed() && !expectedPlaying) { /* eco del comando remoto */ }
            else emitCommand('pause', ytPlayer.getCurrentTime());
          } else if (event.data === YT.PlayerState.BUFFERING) {
            buffering = true;
            showLoading(true, 'Buffering…');
            reportPeer();
          } else if (event.data === YT.PlayerState.ENDED && !suppressed()) {
            emitCommand('ended', ytPlayer.getCurrentTime());
          }
        },
        onError: (event) => {
          const messages = {
            2: 'El link de YouTube no es válido.',
            5: 'YouTube no pudo reproducir este video en este navegador.',
            100: 'El video no existe o fue eliminado.',
            101: 'El dueño no permite reproducirlo fuera de YouTube.',
            150: 'Este video está bloqueado para reproducción incrustada.'
          };
          showError(messages[event.data] || 'YouTube no pudo cargar el video.');
        }
      }
    });
  }

  window.onYouTubeIframeAPIReady = function () {
    ytApiReady = true;
    if (pendingYt) {
      const options = pendingYt;
      pendingYt = null;
      createYt(options);
    }
  };
  if (isYtApiReady()) ytApiReady = true;

  // ------------------------------------------------------------
  // Eventos del <video>
  // ------------------------------------------------------------
  el.video.addEventListener('loadedmetadata', () => {
    if (videoMode === 'youtube') return;
    mediaReady = true;
    showLoading(false);
    if (pending) {
      suppressUntil = Date.now() + 800;
      if (pending.target > 0) setPosition(pending.target);
      setRate(pending.rate || 1);
      if (pending.playing) safePlay();
      pending = null;
    }
    reportPeer();
  });

  el.video.addEventListener('canplay', () => { if (!el.video.ended) showLoading(false); });
  el.video.addEventListener('playing', () => {
    started = true;
    buffering = false;
    hide(el.unlock);
    showLoading(false);
    reportPeer();
    updateOrb(true);
    if (expectedPlaying) setStatus('Sincronizado', 'ok');
  });

  el.video.addEventListener('waiting', () => {
    buffering = true;
    reportPeer();
    if (expectedPlaying || started) showLoading(true, 'Buffering…');
  });

  // Si el evento local coincide con lo que ya mandó el servidor, es un eco:
  // se ignora. Si la persona actuó justo después de un ajuste, se propaga.
  el.video.addEventListener('play', () => {
    if (suppressed() && expectedPlaying) return;
    emitCommand('play');
  });
  el.video.addEventListener('pause', () => {
    if (suppressed() && !expectedPlaying) return;
    emitCommand('pause');
  });
  el.video.addEventListener('seeked', () => { if (!suppressed()) emitCommand('seek'); });
  el.video.addEventListener('ratechange', () => { if (!suppressed() && !nudgeActive) emitCommand('rate'); });
  el.video.addEventListener('ended', () => { if (!suppressed()) emitCommand('ended'); });

  el.video.addEventListener('error', () => {
    if (!currentVideo || videoMode === 'youtube') return;
    const code = el.video.error && el.video.error.code;
    showError(code === 4
      ? 'El archivo no existe, no es compatible o el servidor no permite accederlo.'
      : 'No se pudo cargar el video. Probá con otro link.');
  });

  // ------------------------------------------------------------
  // Usuarios / chat
  // ------------------------------------------------------------
  function renderUsers(users) {
    if (!Array.isArray(users)) return;
    el.avatars.innerHTML = '';
    users.slice(0, 5).forEach((user) => {
      const avatar = document.createElement('span');
      avatar.className = 'avatar' + (user.buffering ? ' buffering' : '');
      avatar.style.background = user.color || '#8b7cff';
      avatar.textContent = initials(user.name);
      avatar.title = (user.name || 'Invitado') + (user.isHost ? ' · anfitrión' : '') +
        (user.buffering ? ' · cargando video' : user.synced === false ? ' · desincronizado' : ' · sincronizado');
      el.avatars.appendChild(avatar);
    });
    if (users.length > 5) {
      const more = document.createElement('span');
      more.className = 'avatar';
      more.style.background = '#31364a';
      more.style.color = '#d7dbe8';
      more.textContent = '+' + (users.length - 5);
      el.avatars.appendChild(more);
    }
    el.userCount.textContent = users.length;
  }

  function appendMessage(msg) {
    if (!msg) return;
    const div = document.createElement('div');
    const own = !msg.system && (msg.id === socket.id || (msg.name && msg.name === myName));
    div.className = 'chat-msg' + (msg.system ? ' system' : own ? ' own' : '');

    if (msg.system) {
      div.textContent = msg.text;
    } else {
      const name = document.createElement('span');
      name.className = 'chat-name';
      name.style.color = msg.color || '#8b7cff';
      name.textContent = (msg.name || 'Invitado') + ':';
      div.appendChild(name);
      div.appendChild(document.createTextNode(msg.text || ''));
    }
    el.chatMessages.appendChild(div);
    while (el.chatMessages.children.length > 100) el.chatMessages.firstChild.remove();
    el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
  }

  el.chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = el.chatInput.value.trim();
    if (!text || !currentRoomId) return;
    socket.emit('chat:send', { text });
    el.chatInput.value = '';
  });

  el.chatToggle.addEventListener('click', () => el.chatPanel.classList.toggle('collapsed'));

  // ------------------------------------------------------------
  // Unirse / reconectar
  // ------------------------------------------------------------
  function saveJoin() {
    if (joinInfo) {
      try { sessionStorage.setItem(STORE_KEY, JSON.stringify(joinInfo)); } catch { /* ignore */ }
    }
  }

  function doJoin() {
    if (joinInfo && socket.connected) socket.emit('room:join', joinInfo);
  }

  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get('sala');
  let storedJoin = null;
  try { storedJoin = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null'); } catch { /* ignore */ }

  if (roomParam) {
    el.inputRoom.value = roomParam;
    if (storedJoin && storedJoin.roomId === roomParam) {
      joinInfo = storedJoin;
      myName = storedJoin.name || 'Invitado';
      el.inputPassword.value = storedJoin.password || '';
      el.inputName.value = storedJoin.name || '';
    }
    el.inputPassword.focus();
  } else {
    el.inputRoom.focus();
  }

  el.btnRandom.addEventListener('click', () => {
    const id = Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 4);
    el.inputRoom.value = id.replace(/[^a-z0-9-]/g, '').slice(0, 12);
    el.inputName.focus();
  });

  el.formJoin.addEventListener('submit', (event) => {
    event.preventDefault();
    el.joinError.textContent = '';
    const roomId = el.inputRoom.value.trim();
    if (!roomId) return;

    myName = el.inputName.value.trim() || 'Invitado';
    joinInfo = { roomId, password: el.inputPassword.value, name: myName };
    saveJoin();
    doJoin();
  });

  socket.on('connect', () => {
    hide(el.banner);
    doJoin(); // también reingresa automáticamente después de un corte de red
    if (currentRoomId) {
      setStatus('Sincronizado', 'ok');
      socket.emit('sync:request');
      pulseOrb();
    }
  });

  socket.on('disconnect', () => {
    show(el.banner);
    setStatus('Reconectando…', 'warn');
  });

  socket.on('connect_error', () => { show(el.banner); });

  socket.on('room:error', (message) => {
    if (currentRoomId) toast(message);
    else el.joinError.textContent = message;
  });

  socket.on('room:joined', (state) => {
    currentRoomId = state.roomId;
    myId = state.you && state.you.id;
    isHost = !!(state.you && state.you.isHost);
    joinInfo = { roomId: state.roomId, password: joinInfo ? joinInfo.password : '', name: myName };
    saveJoin();

    el.roomId.textContent = state.roomId;
    const url = new URL(window.location.href);
    url.searchParams.set('sala', state.roomId);
    window.history.replaceState({}, '', url);

    hide(el.landing);
    show(el.room);

    el.chatMessages.innerHTML = '';
    (state.messages || []).forEach(appendMessage);
    applyState(state);
    if (isHost) toast('Sos el anfitrión de la sala');
  });

  function applyState(state) {
    if (state && Object.prototype.hasOwnProperty.call(state, 'video')) applySource(state.video, state.playback || latestPlayback);
    else if (state && state.playback) applyPlayback(state.playback);
    if (state && state.users) renderUsers(state.users);
    if (state && state.playback) updateOrb(!!state.playback.playing);
  }

  socket.on('sync:state', (state) => {
    applyState(state);
    setStatus('Sincronizado', 'ok');
    pulseOrb();
  });

  socket.on('sync:tick', onTick);

  socket.on('playback:event', (payload) => {
    applyPlayback(payload, payload.action);
    if (payload.action === 'seek' || payload.action === 'play' || payload.action === 'pause') {
      setStatus('Sincronizado', 'ok');
    }
  });

  socket.on('video:changed', (payload) => {
    applySource(payload.video, payload.playback || { position: 0, playing: false, rate: 1 });
    toast((payload.by ? payload.by + ' cargó un video' : 'Nuevo video cargado'));
  });

  socket.on('users:update', (payload) => renderUsers(payload.users));
  socket.on('chat:message', appendMessage);

  // ------------------------------------------------------------
  // Controles de la sala
  // ------------------------------------------------------------
  el.loadBtn.addEventListener('click', () => {
    const url = el.urlInput.value.trim();
    if (!url || !currentRoomId) return;
    socket.emit('video:set', { url });
    el.urlInput.value = '';
  });
  el.urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') el.loadBtn.click();
  });
  el.btnSync.addEventListener('click', () => {
    socket.emit('sync:request');
    setStatus('Sincronizando…', 'warn');
    pulseOrb();
  });
  el.retry.addEventListener('click', () => {
    if (currentVideo) applySource(currentVideo, latestPlayback, true);
  });
  el.errorCopy.addEventListener('click', () => copyText(currentVideo ? currentVideo.url : ''));

  async function copyText(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const input = document.createElement('input');
      input.value = text;
      document.body.appendChild(input);
      input.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      input.remove();
    }
  }

  el.btnCopy.addEventListener('click', async () => {
    await copyText(window.location.href);
    toast('Link de invitación copiado ✓');
  });

  el.btnLeave.addEventListener('click', () => {
    try { sessionStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
    socket.emit('room:leave');
    window.location.href = window.location.pathname;
  });

  // Pedir el estado al volver a la pestaña (los timers se frenan en background).
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && currentRoomId) {
      socket.emit('sync:request');
      pulseOrb();
    }
  });

  // ------------------------------------------------------------
  // Pantalla completa (estilo F11) y modo cine
  // ------------------------------------------------------------
  function setTheater(on) {
    theater = !!on;
    document.body.classList.toggle('theater', theater);
    el.btnTheater.classList.toggle('active', theater);
    wakeUI();
  }

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        if (document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen();
        } else if (el.video.webkitEnterFullscreen) {
          el.video.webkitEnterFullscreen(); // fallback iOS
        } else {
          setTheater(true);
          toast('Tu navegador no permite pantalla completa: usamos modo cine');
        }
      } else if (document.exitFullscreen) {
        await document.exitFullscreen();
      }
    } catch {
      setTheater(true);
      toast('No se pudo activar pantalla completa: usamos modo cine');
    }
  }

  document.addEventListener('fullscreenchange', () => {
    fullscreenActive = !!document.fullscreenElement;
    document.body.classList.toggle('is-fullscreen', fullscreenActive);
    el.btnFullscreen.classList.toggle('active', fullscreenActive);
    if (fullscreenActive) {
      show(el.fsHint);
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => hide(el.fsHint), 2800);
    } else {
      hide(el.fsHint);
    }
    wakeUI();
  });

  el.btnFullscreen.addEventListener('click', toggleFullscreen);
  el.btnTheater.addEventListener('click', () => setTheater(!theater));

  function wakeUI() {
    document.body.classList.remove('ui-idle');
    clearTimeout(uiTimer);
    if ((fullscreenActive || theater) && expectedPlaying) {
      uiTimer = setTimeout(() => document.body.classList.add('ui-idle'), 3200);
    }
  }
  document.addEventListener('mousemove', wakeUI);
  document.addEventListener('touchstart', wakeUI, { passive: true });

  document.addEventListener('keydown', (event) => {
    const target = event.target || {};
    const tag = String(target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || target.isContentEditable) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const key = event.key.toLowerCase();
    if (key === 'f' && !event.repeat) {
      event.preventDefault();
      toggleFullscreen();
    } else if (key === 't' && !event.repeat) {
      event.preventDefault();
      setTheater(!theater);
    } else if (key === 'm' && !event.repeat && videoMode !== 'youtube' && el.video.src) {
      event.preventDefault();
      el.video.muted = !el.video.muted;
      toast(el.video.muted ? 'Silenciado' : 'Audio activado');
    } else if (event.code === 'Space' && currentRoomId) {
      event.preventDefault();
      if (suppressed()) return;
      if (isPlayingLocally()) pauseLocal(); else playLocal();
    }
  });

  el.unlock.addEventListener('click', () => {
    hide(el.unlock);
    if (videoMode === 'youtube') safeYtPlay();
    else safePlay();
    setTimeout(reportPeer, 400);
  });
})();
