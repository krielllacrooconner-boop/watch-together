(() => {
  'use strict';

  // ============================================================
  // SyncRoom — cliente
  //
  // Reglas de oro de la sincronización:
  //  1. El servidor es el reloj autoritativo (sync:tick cada segundo).
  //  2. Una acción local (play/pause/seek/velocidad) "manda" durante
  //     1,5 s. En ese lapso ignoramos ticks viejos para que no te
  //     devuelvan el video atrás mientras arrastrás la barra.
  //  3. YouTube no tiene evento "seek": lo detectamos comparando la
  //     posición real con la esperada.
  // ============================================================

  const $ = (id) => document.getElementById(id);
  const BUILD = 'v6';
  const STORE_KEY = 'syncroom:join:v2';
  const CLIENT_KEY = 'syncroom:client:v1';

  const el = {
    landing: $('view-landing'), room: $('view-room'),
    formJoin: $('form-join'), inputRoom: $('input-room'), inputPassword: $('input-password'),
    inputName: $('input-name'), joinError: $('join-error'), btnRandom: $('btn-random-room'),
    banner: $('connection-banner'),

    roomId: $('room-id-value'), orb: $('sync-orb'), status: $('sync-status'),
    avatars: $('avatars'), userCount: $('user-count-value'),
    btnSync: $('btn-sync'), btnFullscreen: $('btn-fullscreen'), btnTheater: $('btn-theater'),
    btnCopy: $('btn-copy-link'), btnLeave: $('btn-leave'), toast: $('copy-toast'),

    video: $('video-player'), ytBox: $('youtube-player'), ytTarget: $('yt-target'),
    placeholder: $('video-placeholder'),
    loading: $('video-loading'), loadingText: $('loading-text'),
    failure: $('video-error'), errorText: $('error-text'),
    retry: $('btn-retry'), errorCopy: $('btn-error-copy'), errorOpen: $('btn-error-open'),
    unlock: $('play-unlock'), fsHint: $('fs-hint'), source: $('video-source'),
    speed: $('speed-select'),
    urlInput: $('input-video-url'), loadBtn: $('btn-load-video'),

    chatPanel: $('chat-panel'), chatMessages: $('chat-messages'),
    chatForm: $('chat-form'), chatInput: $('chat-input'), chatToggle: $('btn-chat-toggle'),
    buildTag: $('build-tag')
  };

  if (el.buildTag) el.buildTag.textContent = BUILD;

  const socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 4000,
    timeout: 10000
  });

  // ------------------------------------------------------------
  // Estado local
  // ------------------------------------------------------------
  let joinInfo = null;
  let currentRoomId = null;
  let myName = 'Invitado';
  let myId = null;
  let isHost = false;
  let clientId = getClientId();

  let videoMode = 'none'; // none | file | hls | direct | youtube
  let currentVideo = null;
  let mediaReady = false;
  let ytPlayer = null;
  let ytState = null;
  let ytReady = false;
  let ytApiReady = false;
  let pendingYt = null;
  let hls = null;

  let pending = null;
  let latestPlayback = { position: 0, playing: false, rate: 1, receivedAt: Date.now(), revision: -1 };
  let latestRevision = -1;
  let expectedPlaying = false;
  let suppressUntil = 0;
  let programmaticUntil = 0;
  let localIntentUntil = 0;
  let lastLocalSeekAt = 0;
  let buffering = false;
  let bufferingSince = 0;
  let started = false;

  let nudgeTimer = null;
  let nudgeActive = false;
  let lastSync = null;
  let unlockWatch = null;
  let ytPauseTimer = null;
  let ytWatch = { pos: 0, at: 0, lastSeekAt: 0 };
  let statusTimer = null;
  let toastTimer = null;
  let uiTimer = null;
  let hintTimer = null;
  let lastPeerSignature = '';
  let seekTimer = null;
  let pendingSeekPos = null;
  let ytIgnoreUntil = 0;
  let ytRebase = true;

  let queuedCommands = [];
  let theater = false;
  let fullscreenActive = false;

  // ------------------------------------------------------------
  // Utilidades
  // ------------------------------------------------------------
  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

  function show(node) { node.classList.remove('hidden'); }
  function hide(node) { node.classList.add('hidden'); }

  function getClientId() {
    try {
      let id = sessionStorage.getItem(CLIENT_KEY);
      if (!id) {
        id = (window.crypto && crypto.randomUUID)
          ? crypto.randomUUID().replace(/-/g, '')
          : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
        sessionStorage.setItem(CLIENT_KEY, id);
      }
      return id;
    } catch {
      return 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
  }

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
    clearTimeout(unlockWatch);
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

  function hideUnlock() {
    hide(el.unlock);
    clearTimeout(unlockWatch);
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

  function markLocalIntent(ms = 1500) {
    localIntentUntil = Math.max(localIntentUntil, Date.now() + ms);
  }

  function markLocalSeek() {
    lastLocalSeekAt = Date.now();
    markLocalIntent(1600);
  }

  // Arrastrar la barra dispara muchos "seeked" seguidos. Mandamos uno
  // solo, con la posición final, 160 ms después del último movimiento.
  function queueSeek(position) {
    pendingSeekPos = position;
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => {
      const pos = pendingSeekPos;
      pendingSeekPos = null;
      if (pos == null) return;
      emitCommand('seek', pos, { seek: true });
    }, 160);
  }

  function flushSeek() {
    if (pendingSeekPos == null) return;
    clearTimeout(seekTimer);
    const pos = pendingSeekPos;
    pendingSeekPos = null;
    emitCommand('seek', pos, { seek: true });
  }

  function computeTarget(p) {
    // OJO: usamos la hora LOCAL de recepción, nunca `sentAt` del servidor.
    // Si el reloj del usuario está mal configurado, restar contra la hora
    // del servidor producía saltos gigantes (y videos que "no avanzaban").
    const stamp = p && (p.receivedAt || p.sentAt) ? (p.receivedAt || p.sentAt) : Date.now();
    const age = Math.max(0, Date.now() - stamp);
    return Math.max(0, (p && p.position ? p.position : 0) + (p && p.playing ? (age / 1000) * (p.rate || 1) : 0));
  }

  function suppressed() { return Date.now() < suppressUntil; }

  function markProgrammatic(ms = 450) {
    programmaticUntil = Math.max(programmaticUntil, Date.now() + ms);
  }

  function isProgrammatic() { return Date.now() < programmaticUntil; }

  function isYoutube() {
    return videoMode === 'youtube' && ytPlayer && typeof ytPlayer.getCurrentTime === 'function';
  }

  function isReady() {
    if (videoMode === 'youtube') return ytReady && isYoutube();
    return videoMode !== 'none' && mediaReady;
  }

  function isPlayingLocally() {
    if (isYoutube()) return !!(window.YT && ytState === YT.PlayerState.PLAYING);
    return !!el.video.src && !el.video.paused && !el.video.ended;
  }

  function mediaCanPlay() {
    if (isYoutube()) return ytReady && isYoutube();
    return el.video.readyState >= 2;
  }

  function isLive() {
    if (isYoutube()) {
      try {
        return !!(ytPlayer.getDuration && ytPlayer.getDuration() === 0 && ytState === (window.YT && YT.PlayerState.PLAYING));
      } catch { return false; }
    }
    return mediaReady && (!Number.isFinite(el.video.duration) || el.video.duration === Infinity);
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
    // Los seeks de YouTube tardan en reflejarse en los eventos de estado:
    // damos más margen para no confundirlos con una acción del usuario.
    markProgrammatic(isYoutube() ? 1600 : 600);
    try {
      if (isYoutube()) {
        if (!isLive()) ytPlayer.seekTo(t, true);
        // La referencia del detector pasa a ser el destino del seek
        // propio. Así, aunque YouTube tarde en bufferear más que la
        // ventana de gracia, al volver no confundimos nuestro seek con
        // un arrastre del usuario.
        ytWatch.pos = t;
        ytWatch.at = Date.now();
      } else {
        el.video.currentTime = Number.isFinite(el.video.duration) ? Math.min(t, el.video.duration) : t;
      }
    } catch { /* el media todavía no acepta seeks */ }
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

  function speedValue(rate) {
    const options = [0.75, 1, 1.25, 1.5, 2];
    return options.reduce((best, r) => Math.abs(r - rate) < Math.abs(best - rate) ? r : best, 1);
  }

  function syncSpeedSelect(rate) {
    if (document.activeElement === el.speed) return;
    const value = String(speedValue(Number(rate) || 1));
    if (el.speed.value !== value) el.speed.value = value;
  }

  function nudge(diff, baseRate) {
    if (isYoutube()) return;
    nudgeActive = true;
    const base = clamp(Number(baseRate) || 1, 0.5, 2);
    // El ajuste es RELATIVO a la velocidad elegida: a 1.5× no podemos
    // bajar a 1.03× porque el video se atrasaría muchísimo. Corregimos
    // de a poco en 1,4 s para que no se note.
    const factor = clamp(1 + (diff / 1.4) * 0.55, 0.82, 1.18);
    const rate = clamp(base * factor, 0.5, 2);
    suppressUntil = Date.now() + 200;
    setRate(rate);
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => {
      suppressUntil = Date.now() + 200;
      setRate(base);
      nudgeActive = false;
    }, 1400);
  }

  // ------------------------------------------------------------
  // Reproducción local
  // ------------------------------------------------------------
  function safePlay() {
    if (isPlayingLocally()) return;
    try {
      const result = el.video.play();
      if (result && result.catch) {
        result.catch((err) => {
          if (!currentVideo || videoMode === 'youtube') return;
          if (err && err.name === 'AbortError') return;
          if (err && err.name === 'NotAllowedError') showUnlock(true);
          else if (err && err.name === 'NotSupportedError') showError('Este formato no es compatible con tu navegador.');
          else showLoading(true, 'Esperando el video…');
        });
      }
    } catch { showUnlock(true); }
  }

  function scheduleYtUnlockCheck(delay = 2500) {
    clearTimeout(unlockWatch);
    unlockWatch = setTimeout(() => {
      if (!expectedPlaying || !window.YT) return;
      if (ytState === YT.PlayerState.PLAYING) return;
      if (ytState === YT.PlayerState.BUFFERING) {
        scheduleYtUnlockCheck(2500);
        return;
      }
      showUnlock(true);
    }, delay);
  }

  function safeYtPlay() {
    if (!ytPlayer || !ytPlayer.playVideo) return;
    try { ytPlayer.unMute(); ytPlayer.playVideo(); } catch { /* ignore */ }
    scheduleYtUnlockCheck();
  }

  function playLocal() {
    if (isYoutube()) safeYtPlay();
    else safePlay();
  }

  function pauseLocal() {
    hideUnlock();
    try { if (isYoutube()) ytPlayer.pauseVideo(); else el.video.pause(); } catch { /* ignore */ }
  }

  function emitCommand(action, time, opts = {}) {
    if (!currentRoomId) return;
    const payload = {
      action,
      time: Number.isFinite(time) ? time : getPosition()
    };
    if (action === 'rate') payload.rate = Number(opts.rate) || getRate();
    if (opts.seek || (action === 'play' && Date.now() - lastLocalSeekAt < 2500)) payload.seek = true;

    // Si la posición del cliente está lejos de la que cree el servidor
    // (por ejemplo, arrastraste la barra y YouTube no avisó), mandamos
    // nuestra posición como confiable. Así "play" no rebobina el video.
    if (!payload.seek && (action === 'play' || action === 'pause')) {
      const expected = computeTarget(latestPlayback);
      if (Math.abs(payload.time - expected) > 1.2) payload.seek = true;
    }

    if (!socket.connected) {
      queuedCommands.push(payload);
      if (queuedCommands.length > 12) queuedCommands.shift();
      return;
    }
    socket.emit('playback:command', payload);
  }

  function flushQueuedCommands() {
    if (!queuedCommands.length) return;
    const commands = queuedCommands.slice();
    queuedCommands = [];
    commands.forEach((payload) => socket.emit('playback:command', payload));
  }

  function reportPeer() {
    if (!currentRoomId) return;
    const signature = (buffering ? '1' : '0') + ':' + ((started || !expectedPlaying) ? '1' : '0');
    if (signature === lastPeerSignature) return;
    lastPeerSignature = signature;
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
    p.receivedAt = Date.now();

    // Si el usuario acaba de arrastrar la barra de YouTube, su posición
    // manda: no dejamos que un evento remoto lo devuelva atrás.
    if (checkYtSeek()) return;

    if (Number.isFinite(p.revision)) latestRevision = Math.max(latestRevision, p.revision);
    const target = computeTarget(p);
    latestPlayback = p;
    expectedPlaying = !!p.playing;
    updateOrb(p.playing);
    syncSpeedSelect(p.rate);

    if (!isReady()) {
      pending = { target, playing: p.playing, rate: p.rate || 1 };
      return;
    }
    pending = null;

    // Una acción local reciente manda: no la pisamos con este evento.
    if (Date.now() < localIntentUntil) return;

    suppressUntil = Date.now() + 900;
    markProgrammatic(700);
    clearTimeout(nudgeTimer);
    nudgeActive = false;

    if (!isLive() && Math.abs(getPosition() - target) > 0.7) setPosition(target);
    setRate(p.rate || 1);

    if (p.playing) {
      if (buffering || !mediaCanPlay()) {
        if (el.unlock.classList.contains('hidden')) showLoading(true, 'Cargando video…');
      } else {
        playLocal();
      }
    } else {
      pauseLocal();
      showLoading(false);
    }

    if (action === 'seek' || action === 'sync') pulseOrb();
  }

  function onTick(p) {
    if (!p) return;
    p.receivedAt = Date.now();

    // Mismo chequeo que en applyPlayback: si el usuario movió la barra
    // de YouTube, reportamos ese seek antes de corregir la deriva.
    if (checkYtSeek()) return;

    const revision = Number.isFinite(p.revision) ? p.revision : latestRevision;
    if (revision < latestRevision) { lastSync = { reason: 'oldRev', rev: revision, latest: latestRevision }; return; } // tick viejo
    if (Date.now() < localIntentUntil && revision === latestRevision) { lastSync = { reason: 'localIntent', left: localIntentUntil - Date.now() }; return; }

    const target = computeTarget(p);
    latestPlayback = p;
    expectedPlaying = !!p.playing;
    updateOrb(p.playing);
    syncSpeedSelect(p.rate);

    if (!isReady()) {
      pending = { target, playing: p.playing, rate: p.rate || 1 };
      return;
    }
    pending = null;

    if (p.playing && !isPlayingLocally()) {
      if (!el.unlock.classList.contains('hidden')) return;

      // Si el video lleva mucho buffereando, insistimos con play() y,
      // si de verdad no arranca, mostramos error con opción de reintentar.
      const stuckFor = buffering && bufferingSince ? Date.now() - bufferingSince : 0;
      if (stuckFor > 25000) {
        buffering = false;
        bufferingSince = 0;
        showError('El video no arranca. Revisá tu conexión y tocá Reintentar.');
        return;
      }
      if (stuckFor > 6000) {
        buffering = false;
        bufferingSince = 0;
        suppressUntil = Date.now() + 900;
        markProgrammatic(700);
        playLocal();
        return;
      }

      if (buffering || !mediaCanPlay()) {
        showLoading(true, 'Cargando video…');
        return;
      }
      suppressUntil = Date.now() + 900;
      markProgrammatic(700);
      playLocal();
      return;
    }

    if (!p.playing && isPlayingLocally()) {
      suppressUntil = Date.now() + 700;
      markProgrammatic(700);
      pauseLocal();
      return;
    }

    // Mientras bufferea no conviene mover la posición: empeora el stall.
    if (buffering || isLive()) { lastSync = { reason: buffering ? 'buffering' : 'live', pos: +getPosition().toFixed(2) }; return; }

    const diff = target - getPosition();
    const distance = Math.abs(diff);
    // Pausados conviene quedar casi exactos porque de ahí arranca el
    // siguiente play; reproduciendo toleramos un poco más.
    const tolerance = p.playing ? 1.2 : 0.4;
    lastSync = {
      t: Date.now(), reason: 'diff', target: +target.toFixed(2), pos: +getPosition().toFixed(2),
      distance: +distance.toFixed(2), tol: tolerance, playing: !!p.playing, rev: revision,
      seekAgo: lastLocalSeekAt ? Date.now() - lastLocalSeekAt : null
    };

    if (distance > tolerance) {
      suppressUntil = Date.now() + 750;
      setPosition(target);
      pulseOrb();
      if (distance > 4) {
        setStatus('Ajustando…', 'warn');
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => setStatus('Sincronizado', 'ok'), 1000);
      }
    } else if (p.playing && distance > 0.6) {
      if (isYoutube()) {
        // YouTube solo admite velocidades discretas: un seek corto alcanza,
        // pero no lo repetimos cada segundo (se ve como tirones).
        if (Date.now() - lastLocalSeekAt > 4000) {
          suppressUntil = Date.now() + 600;
          setPosition(target);
          lastLocalSeekAt = Date.now();
        }
      } else if (!nudgeActive) {
        nudge(diff, p.rate || 1);
      }
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

  function resetYtWatch() {
    ytWatch.pos = isYoutube() ? getPosition() : 0;
    ytWatch.at = Date.now();
  }

  function resetYtBox() {
    el.ytBox.innerHTML = '<div id="yt-target"></div>';
    el.ytTarget = $('yt-target');
  }

  function clearVideo() {
    destroyHls();
    clearTimeout(unlockWatch);
    clearTimeout(ytPauseTimer);
    clearTimeout(nudgeTimer);
    clearTimeout(seekTimer);
    pendingSeekPos = null;
    nudgeActive = false;
    pendingYt = null;
    videoMode = 'none';
    currentVideo = null;
    mediaReady = false;
    started = false;
    buffering = false;
    bufferingSince = 0;
    pending = null;
    expectedPlaying = false;
    ytReady = false;
    latestPlayback = { position: 0, playing: false, rate: 1, receivedAt: Date.now(), revision: latestRevision };
    try { el.video.pause(); el.video.removeAttribute('src'); el.video.load(); } catch { /* ignore */ }
    el.video.classList.add('hidden');
    el.ytBox.classList.add('hidden');
    resetYtBox();
    show(el.placeholder);
    hide(el.loading);
    hide(el.failure);
    hide(el.unlock);
    el.source.textContent = 'Sin video';
    syncSpeedSelect(1);
    reportPeer();
  }

  function applySource(info, p, force) {
    if (!info) { clearVideo(); return; }
    if (p) p.receivedAt = Date.now();
    clearTimeout(seekTimer);
    pendingSeekPos = null;

    if (p && Number.isFinite(p.revision)) latestRevision = Math.max(latestRevision, p.revision);

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
    buffering = false;
    bufferingSince = 0;
    const source = p || latestPlayback;
    const initialTarget = computeTarget(source);
    pending = { target: initialTarget, playing: !!source.playing, rate: source.rate || 1 };
    expectedPlaying = !!pending.playing;
    latestPlayback = source;
    suppressUntil = Date.now() + 1200;
    updateOrb(expectedPlaying);
    syncSpeedSelect(pending.rate);
    reportPeer();

    if (info.type === 'youtube') setupYoutube(info, pending);
    else setupDirect(info);
  }

  function setupDirect(info) {
    videoMode = info.type;
    ytReady = false;
    destroyHls();
    clearTimeout(unlockWatch);
    pendingYt = null;

    try { if (ytPlayer && ytPlayer.destroy) ytPlayer.destroy(); } catch { /* ignore */ }
    ytPlayer = null;
    ytState = null;

    el.ytBox.classList.add('hidden');
    resetYtBox();
    el.video.classList.remove('hidden');
    el.video.controls = true;
    el.video.preload = 'auto';
    el.video.preservesPitch = true;
    showLoading(true, info.type === 'hls' ? 'Conectando con el stream…' : 'Preparando video…');

    // Limpiamos cualquier fuente anterior antes de montar la nueva.
    try { el.video.pause(); el.video.removeAttribute('src'); el.video.load(); } catch { /* ignore */ }

    if (info.type === 'hls' && window.Hls && Hls.isSupported()) {
      let recovered = 0;
      hls = new Hls({
        enableWorker: true,
        capLevelToPlayerSize: true,
        maxBufferLength: 40,
        maxMaxBufferLength: 80,
        backBufferLength: 90,
        startLevel: -1,
        manifestLoadingMaxRetry: 3,
        levelLoadingMaxRetry: 3,
        fragLoadingMaxRetry: 4
      });
      hls.attachMedia(el.video);
      hls.loadSource(info.url);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        showLoading(false);
        setStatus(expectedPlaying ? 'Sincronizado' : 'Listo', 'ok');
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
      return;
    }

    if (info.type === 'hls' && !el.video.canPlayType('application/vnd.apple.mpegurl')) {
      showError('Tu navegador no puede reproducir HLS y hls.js no cargó. Revisá bloqueadores de anuncios o recargá la página.');
      return;
    }

    // Safari reproduce HLS nativamente; los demás, archivos directos.
    el.video.src = info.url;
    el.video.load();
  }

  function isYtApiReady() { return !!(window.YT && window.YT.Player); }

  function setupYoutube(info, p) {
    videoMode = 'youtube';
    mediaReady = false;
    ytReady = false;
    destroyHls();
    try { el.video.pause(); el.video.removeAttribute('src'); el.video.load(); } catch { /* ignore */ }
    el.video.classList.add('hidden');
    el.ytBox.classList.remove('hidden');
    showLoading(true, 'Cargando YouTube…');

    const options = {
      videoId: info.id,
      position: p.target || 0,
      playing: p.playing,
      rate: p.rate || 1
    };

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
    ytReady = false;
    resetYtBox();

    ytPlayer = new YT.Player(el.ytTarget, {
      videoId: options.videoId,
      playerVars: {
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        iv_load_policy: 3,
        enablejsapi: 1,
        origin: window.location.origin,
        vq: 'hd1080'
      },
      events: {
        onReady: (event) => {
          ytReady = true;
          ytState = YT.PlayerState.UNSTARTED;
          suppressUntil = Date.now() + 1200;
          // El seek inicial a la posición de la sala no debe confundirse
          // con un arrastre del usuario.
          markProgrammatic(2000);
          hideError();
          showLoading(false);
          setStatus(expectedPlaying ? 'Sincronizado' : 'Listo', 'ok');
          try { event.target.setPlaybackRate(ytRate(options.rate || 1)); } catch { /* ignore */ }
          try { if (event.target.setPlaybackQuality) event.target.setPlaybackQuality('hd1080'); } catch { /* ignore */ }
          if (options.position > 0) {
            event.target.seekTo(options.position, true);
            // Referencia inicial = destino del seek, no la posición 0.
            ytWatch.pos = options.position;
            ytWatch.at = Date.now();
          } else {
            resetYtWatch();
          }
          if (options.playing) playLocal(); else event.target.pauseVideo();
          reportPeer();
        },
        onStateChange: (event) => {
          ytState = event.data;

          if (event.data === YT.PlayerState.PLAYING) {
            started = true;
            clearTimeout(unlockWatch);
            clearTimeout(ytPauseTimer);
            hide(el.unlock);
            showLoading(false);
            buffering = false;
            bufferingSince = 0;
            // Apenas YouTube sale del buffering, revisamos si hubo un
            // arrastre. Si esperáramos al intervalo de 250 ms, un tick
            // viejo podría devolver el video a la posición anterior.
            checkYtSeek();
            reportPeer();
            updateOrb(true);
            try { if (ytPlayer.setPlaybackQuality) ytPlayer.setPlaybackQuality('hd1080'); } catch { /* ignore */ }

            // Solo avisamos al servidor cuando la reproducción la inició
            // una persona. Si venía de un tick/estado remoto, expectedPlaying
            // ya es true y avisar otra vez solo genera eco.
            if (!expectedPlaying && !isProgrammatic()) {
              emitCommand('play', ytPlayer.getCurrentTime());
            }
            return;
          }

          if (event.data === YT.PlayerState.PAUSED) {
            showLoading(false);
            buffering = false;
            bufferingSince = 0;
            // Mismo caso que PLAYING: un arrastre estando pausado también
            // pasa por BUFFERING y hay que reportarlo cuanto antes.
            checkYtSeek();
            reportPeer();
            updateOrb(false);

            // OJO: si el video todavía no arrancó nunca, este PAUSED es el
            // bloqueo de autoplay del navegador (o el pauseVideo inicial),
            // no una acción del usuario. Si lo mandáramos, un viewer nuevo
            // pausaría la sala de todos.
            if (expectedPlaying && started && !isProgrammatic()) {
              markLocalIntent(1600);
              // Pequeño debounce: al arrastrar la barra YouTube a veces
              // manda PAUSED y enseguida PLAYING. No queremos pausar a todos.
              clearTimeout(ytPauseTimer);
              ytPauseTimer = setTimeout(() => {
                if (videoMode === 'youtube' && ytState === YT.PlayerState.PAUSED) {
                  emitCommand('pause', ytPlayer.getCurrentTime());
                }
              }, 300);
            }
            return;
          }

          if (event.data === YT.PlayerState.BUFFERING) {
            buffering = true;
            bufferingSince = bufferingSince || Date.now();
            showLoading(true, 'Buffering…');
            reportPeer();
            if (!suppressed()) markLocalIntent(1200);
            // No reseteamos ytWatch: al volver de buffering comparamos
            // contra la última posición buena para detectar el arrastre.
            return;
          }

          if (event.data === YT.PlayerState.ENDED && !isProgrammatic()) {
            emitCommand('ended', 0);
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
      // Refrescamos la posición: entre el click y la API lista puede
      // haber pasado tiempo y el estado del servidor ya cambió.
      const options = {
        ...pendingYt,
        position: computeTarget(latestPlayback),
        playing: expectedPlaying,
        rate: latestPlayback.rate || 1
      };
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
    setStatus(expectedPlaying ? 'Sincronizado' : 'Listo', 'ok');
    if (pending) {
      suppressUntil = Date.now() + 800;
      if (pending.target > 0) setPosition(pending.target);
      setRate(pending.rate || 1);
      if (pending.playing) safePlay();
      pending = null;
    }
    reportPeer();
  });

  el.video.addEventListener('canplay', () => {
    buffering = false;
    bufferingSince = 0;
    if (!el.video.ended) showLoading(false);
    // Si el servidor dice "reproduciendo" pero el video quedó pausado
    // (por un stall o por una pausa del sistema), reintentamos acá.
    if (expectedPlaying && el.video.paused && !el.video.ended &&
        el.unlock.classList.contains('hidden')) {
      suppressUntil = Date.now() + 700;
      markProgrammatic(600);
      safePlay();
    }
  });

  el.video.addEventListener('playing', () => {
    started = true;
    buffering = false;
    bufferingSince = 0;
    hide(el.unlock);
    showLoading(false);
    reportPeer();
    updateOrb(true);
    if (expectedPlaying) setStatus('Sincronizado', 'ok');
  });

  el.video.addEventListener('waiting', () => {
    buffering = true;
    bufferingSince = bufferingSince || Date.now();
    reportPeer();
    if (expectedPlaying || started) showLoading(true, 'Buffering…');
  });

  el.video.addEventListener('stalled', () => {
    buffering = true;
    bufferingSince = bufferingSince || Date.now();
    reportPeer();
    if (expectedPlaying || started) showLoading(true, 'Buffering…');
  });

  el.video.addEventListener('seeking', () => {
    // Ignoramos los seeks que provocamos nosotros al sincronizar.
    if (isProgrammatic()) return;
    markLocalSeek();
  });

  el.video.addEventListener('seeked', () => {
    if (isProgrammatic()) return;
    markLocalSeek();
    queueSeek(el.video.currentTime);
  });

  el.video.addEventListener('play', () => {
    // Si el servidor ya está en "playing", esto es el eco de nuestra
    // propia sincronización, no una acción del usuario.
    if (expectedPlaying || isProgrammatic()) return;
    markLocalIntent(1500);
    flushSeek();
    emitCommand('play', el.video.currentTime);
  });

  el.video.addEventListener('pause', () => {
    if (!expectedPlaying || !started || isProgrammatic()) return;
    markLocalIntent(1500);
    flushSeek();
    emitCommand('pause', el.video.currentTime);
  });

  el.video.addEventListener('ratechange', () => {
    if (suppressed() || nudgeActive || isProgrammatic()) return;
    markLocalIntent(1200);
    emitCommand('rate', el.video.currentTime, { rate: el.video.playbackRate });
  });

  el.video.addEventListener('ended', () => {
    if (!isProgrammatic()) emitCommand('ended', 0);
  });

  el.video.addEventListener('error', () => {
    if (!currentVideo || videoMode === 'youtube') return;
    const code = el.video.error && el.video.error.code;
    showError(code === 4
      ? 'El archivo no existe, no es compatible o el servidor no permite accederlo.'
      : 'No se pudo cargar el video. Probá con otro link.');
  });

  // ------------------------------------------------------------
  // Detector de seeks de YouTube (la API no expone "seeked")
  // ------------------------------------------------------------
  // Además de detectarlos cada 250 ms, se llama al principio de cada
  // tick: si el usuario acaba de arrastrar la barra, el tick NO debe
  // devolverle el video a la posición vieja antes de que lo detectemos.
  function checkYtSeek() {
    if (videoMode !== 'youtube' || !ytPlayer || !window.YT || !ytReady) return false;

    const now = Date.now();

    // Ventana de gracia: después de un seek (nuestro o del usuario)
    // YouTube tarda en reflejar la posición nueva. Si muestreáramos
    // en ese lapso, confundiríamos la posición vieja con otro arrastre.
    if (isProgrammatic()) { ytRebase = true; return false; }
    if (now < ytIgnoreUntil) return false;

    // Durante BUFFERING (lo que dispara YouTube al arrastrar) no
    // tocamos la referencia: al volver comparamos contra la última
    // posición buena. Si la reiniciáramos, el salto se perdería.
    if (buffering) return false;

    if (ytState !== YT.PlayerState.PLAYING && ytState !== YT.PlayerState.PAUSED) {
      ytRebase = true;
      return false;
    }

    const pos = ytPlayer.getCurrentTime();

    if (ytRebase || !ytWatch.at) {
      ytRebase = false;
      ytWatch.pos = pos;
      ytWatch.at = now;
      return false;
    }

    const elapsed = (now - ytWatch.at) / 1000;
    // Tope de 3 s: si hubo un stall largo, no confundimos eso con un seek.
    const maxAdvance = Math.min(elapsed * Math.max(0.5, getRate()), 3);
    const delta = pos - ytWatch.pos;

    if (delta > maxAdvance + 1.0 || delta < -1.0) {
      ytWatch.lastSeekAt = now;
      markLocalSeek();
      emitCommand('seek', pos, { seek: true });
      ytIgnoreUntil = now + 2500;
      ytRebase = true;
      return true;
    }

    ytWatch.pos = pos;
    ytWatch.at = now;
    return false;
  }

  setInterval(checkYtSeek, 250);

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
    const nearBottom = el.chatMessages.scrollHeight - el.chatMessages.scrollTop - el.chatMessages.clientHeight < 90;
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
    if (nearBottom || own) el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
  }

  el.chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = el.chatInput.value.trim();
    if (!text || !currentRoomId) return;
    if (!socket.connected) { toast('Sin conexión. Tu mensaje no se envió.'); return; }
    socket.emit('chat:send', { text });
    el.chatInput.value = '';
  });

  el.chatToggle.addEventListener('click', () => el.chatPanel.classList.toggle('collapsed'));

  // ------------------------------------------------------------
  // Unirse / reconectar
  // ------------------------------------------------------------
  function saveJoin() {
    if (!joinInfo) return;
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(joinInfo)); } catch { /* ignore */ }
  }

  function doJoin() {
    if (!joinInfo || !socket.connected) return;
    socket.emit('room:join', { ...joinInfo, clientId });
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
    doJoin(); // también reingresa después de un corte de red
    if (currentRoomId) setStatus('Reconectando…', 'warn');
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
    latestRevision = -1; // el servidor pudo haberse reiniciado
    currentRoomId = state.roomId;
    myId = state.you && state.you.id;
    isHost = !!(state.you && state.you.isHost);
    myName = (state.you && state.you.name) || myName;
    joinInfo = { roomId: state.roomId, password: joinInfo ? joinInfo.password : '', name: myName };
    saveJoin();

    el.roomId.textContent = state.roomId;
    const url = new URL(window.location.href);
    url.searchParams.set('sala', state.roomId);
    window.history.replaceState({}, '', url);

    hide(el.landing);
    show(el.room);
    setStatus('Sincronizado', 'ok');

    el.chatMessages.innerHTML = '';
    (state.messages || []).forEach(appendMessage);
    applyState(state);
    flushQueuedCommands();
    if (isHost) toast('Sos el anfitrión de la sala');
  });

  function applyState(state) {
    if (!state) return;
    if (Array.isArray(state.users)) renderUsers(state.users);
    if (Object.prototype.hasOwnProperty.call(state, 'video')) {
      applySource(state.video, state.playback || latestPlayback);
    } else if (state.playback) {
      applyPlayback(state.playback);
    }
    if (state.playback) {
      updateOrb(!!state.playback.playing);
      syncSpeedSelect(state.playback.rate);
    }
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
    toast(payload.by ? payload.by + ' cargó un video' : 'Nuevo video cargado');
  });

  socket.on('users:update', (payload) => renderUsers(payload.users));
  socket.on('chat:message', appendMessage);

  // ------------------------------------------------------------
  // Controles de la sala
  // ------------------------------------------------------------
  el.loadBtn.addEventListener('click', () => {
    const url = el.urlInput.value.trim();
    if (!url || !currentRoomId) return;
    if (!socket.connected) { toast('Sin conexión. Esperá a reconectar.'); return; }
    socket.emit('video:set', { url });
    el.urlInput.value = '';
  });

  el.urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') el.loadBtn.click();
  });

  el.btnSync.addEventListener('click', () => {
    localIntentUntil = 0;
    suppressUntil = 0;
    socket.emit('sync:request');
    setStatus('Sincronizando…', 'warn');
    pulseOrb();
  });

  el.retry.addEventListener('click', () => {
    localIntentUntil = 0;
    suppressUntil = 0;
    if (currentVideo) applySource(currentVideo, latestPlayback, true);
  });

  el.errorCopy.addEventListener('click', () => copyText(currentVideo ? currentVideo.url : ''));
  el.errorOpen.addEventListener('click', () => {
    if (currentVideo && currentVideo.url) window.open(currentVideo.url, '_blank', 'noopener');
  });

  el.speed.addEventListener('change', () => {
    const rate = Number(el.speed.value) || 1;
    markLocalIntent(1500);
    suppressUntil = Date.now() + 300;
    setRate(rate);
    emitCommand('rate', getPosition(), { rate });
  });

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

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && currentRoomId) {
      localIntentUntil = 0;
      suppressUntil = 0;
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
          el.video.webkitEnterFullscreen();
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
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable) return;
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
    } else if (event.code === 'Space' && currentRoomId && tag !== 'button' && tag !== 'a') {
      event.preventDefault();
      if (isProgrammatic()) return;
      markLocalIntent(1300);
      if (isPlayingLocally()) pauseLocal(); else playLocal();
    }
  });

  el.unlock.addEventListener('click', () => {
    hide(el.unlock);
    // Si la sala ya está reproduciendo, nos paramos en el punto actual
    // antes de arrancar: así el viewer no empieza atrasado varios segundos.
    if (latestPlayback && expectedPlaying) {
      const target = computeTarget(latestPlayback);
      if (Math.abs(getPosition() - target) > 1) setPosition(target);
    }
    markLocalIntent(900);
    if (videoMode === 'youtube') safeYtPlay();
    else safePlay();
    setTimeout(reportPeer, 400);
  });

  // Diagnóstico liviano (consola del navegador):
  //   __syncroomDebug()
  window.__syncroomDebug = () => ({
    build: BUILD,
    room: currentRoomId,
    name: myName,
    clientId,
    mode: videoMode,
    youtubeState: ytState,
    youtubeReady: ytReady,
    ready: isReady(),
    expectedPlaying,
    playingNow: isPlayingLocally(),
    buffering,
    position: Number(getPosition().toFixed(2)),
    target: latestPlayback ? Number(computeTarget(latestPlayback).toFixed(2)) : null,
    nudge: nudgeActive,
    lastSync: lastSync ? { ...lastSync, t: undefined } : null,
    suppressMs: Math.max(0, suppressUntil - Date.now()),
    localIntentMs: Math.max(0, localIntentUntil - Date.now()),
    rate: getRate(),
    revision: latestRevision,
    pending: pending ? { ...pending } : null
  });
})();
