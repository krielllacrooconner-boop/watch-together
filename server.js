'use strict';

/**
 * SyncRoom — servidor de salas sincronizadas
 * ---------------------------------------------------------------
 * El reloj de reproducción es AUTORITATIVO del servidor:
 * los clientes NO mandan su posición cada X segundos (eso provocaba
 * que se pisaran entre sí). El servidor guarda (posición, estado,
 * velocidad, momento del último cambio) y emite un "tick" por segundo.
 * Cada cliente calcula la posición esperada y corrige su deriva.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: { origin: '*' },
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e5
});

// ---------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------
const MAX_MESSAGES = 100;
const MAX_URL_LENGTH = 2000;
const MAX_POSITION = 60 * 60 * 24; // 24 horas
const EMPTY_ROOM_TTL = 30 * 60 * 1000; // conservar sala vacía 30 min
const TICK_MS = 1000;

const USER_COLORS = [
  '#8b7cff', '#2dd4bf', '#f472b6', '#a3e635',
  '#fb923c', '#60a5fa', '#c084fc', '#34d399'
];

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function sanitizeRoomId(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function sanitizeName(raw) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 24);
  return name || 'Invitado';
}

function sanitizeUrl(raw) {
  let text = String(raw || '').trim();
  if (!text || text.length > MAX_URL_LENGTH) return null;

  // Si pegaron texto con el link en medio, tomamos la primera URL http(s)
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return null;
  text = match[0];

  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname || url.hostname.length > 253) return null;
    return text;
  } catch {
    return null;
  }
}

function youtubeId(raw) {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0];
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      let id = null;
      if (url.pathname === '/watch') id = url.searchParams.get('v');
      else id = (url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/) || [])[1] || null;
      return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
  } catch { /* no es URL */ }
  return null;
}

function detectVideoType(url) {
  const id = youtubeId(url);
  if (id) return { type: 'youtube', url, id };

  const clean = url.split(/[?#]/)[0].toLowerCase();
  if (/\.m3u8$/.test(clean) || /\/manifest\.m3u8/.test(clean)) {
    return { type: 'hls', url };
  }
  if (/\.(mp4|webm|ogv|ogg|mov|m4v)$/.test(clean)) {
    return { type: 'file', url };
  }
  return { type: 'direct', url };
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function randomRoomId() {
  return crypto.randomBytes(3).toString('hex');
}

function createRoom(id, password) {
  return {
    id,
    password: password || null,
    video: null,
    playback: { position: 0, playing: false, rate: 1, updatedAt: Date.now() },
    users: new Map(),
    messages: [],
    hostId: null,
    revision: 0,
    emptySince: null
  };
}

const rooms = Object.create(null);

/** Posición actual del reloj servidor (si está reproduciendo, avanza sola). */
function playbackOf(room) {
  const p = room.playback;
  const elapsed = p.playing ? Math.max(0, (Date.now() - p.updatedAt) / 1000) * p.rate : 0;
  return {
    position: Math.min(MAX_POSITION, p.position + elapsed),
    playing: p.playing,
    rate: p.rate,
    revision: room.revision,
    sentAt: Date.now()
  };
}

function publicUsers(room) {
  return Array.from(room.users.entries()).map(([id, user]) => ({
    id,
    name: user.name,
    color: user.color,
    buffering: !!user.buffering,
    synced: user.synced !== false,
    isHost: id === room.hostId
  }));
}

function publicRoom(room) {
  return {
    roomId: room.id,
    hasPassword: !!room.password,
    video: room.video,
    playback: playbackOf(room),
    users: publicUsers(room),
    messages: room.messages,
    hostId: room.hostId
  };
}

function broadcastUsers(roomId, room) {
  io.to(roomId).emit('users:update', { users: publicUsers(room), hostId: room.hostId });
}

function pushMessage(room, roomId, message) {
  const full = { id: crypto.randomBytes(6).toString('hex'), ts: Date.now(), ...message };
  room.messages.push(full);
  if (room.messages.length > MAX_MESSAGES) room.messages.shift();
  io.to(roomId).emit('chat:message', full);
}

function pickColor(room) {
  const used = new Set(Array.from(room.users.values()).map((u) => u.color));
  return USER_COLORS.find((c) => !used.has(c)) || USER_COLORS[room.users.size % USER_COLORS.length];
}

function ensureHost(room) {
  if (!room.hostId || !room.users.has(room.hostId)) {
    room.hostId = room.users.keys().next().value || null;
  }
}

function rateLimit(socket, key, max, windowMs) {
  const now = Date.now();
  socket.data.limits = socket.data.limits || Object.create(null);
  const bucket = socket.data.limits[key] || { start: now, count: 0 };
  if (now - bucket.start > windowMs) {
    bucket.start = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  socket.data.limits[key] = bucket;
  return bucket.count <= max;
}

function emitPlayback(roomId, room, action) {
  room.playback.updatedAt = Date.now();
  room.revision += 1;
  const state = playbackOf(room);
  io.to(roomId).emit('playback:event', { ...state, action });
  io.to(roomId).emit('sync:tick', state);
}

function leaveRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const room = rooms[roomId];
  socket.leave(roomId);
  socket.data.roomId = null;

  if (!room) return;
  const user = room.users.get(socket.id);
  room.users.delete(socket.id);
  ensureHost(room);

  if (room.users.size === 0) {
    // Congelamos el reloj: si todos salen, el video no debe seguir avanzando
    // en una sala vacía (y al volver, tampoco dar un salto de minutos).
    if (room.playback.playing) {
      room.playback.position = playbackOf(room).position;
      room.playback.playing = false;
      room.playback.updatedAt = Date.now();
      room.revision += 1;
    }
    room.emptySince = Date.now();
  } else {
    pushMessage(room, roomId, {
      name: 'Sistema',
      system: true,
      text: `${user ? user.name : 'Alguien'} salió de la sala.`
    });
  }
  broadcastUsers(roomId, room);
}

// ---------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: Object.keys(rooms).length, uptime: Math.round(process.uptime()) });
});
app.use((req, res) => {
  if (req.method === 'GET') return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  return res.status(404).end();
});

// ---------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------
io.on('connection', (socket) => {
  socket.data.limits = Object.create(null);
  socket.data.roomId = null;
  socket.data.name = 'Invitado';

  socket.on('room:join', (payload = {}) => {
    const requestedId = sanitizeRoomId(payload && payload.roomId);
    if (!requestedId) {
      socket.emit('room:error', 'Ese nombre de sala no es válido.');
      return;
    }

    const password = payload.password == null ? '' : String(payload.password).slice(0, 100);
    const name = sanitizeName(payload && payload.name);

    const existing = rooms[requestedId];
    if (existing && existing.password && existing.password !== password) {
      socket.emit('room:error', 'Contraseña incorrecta para esa sala.');
      return;
    }

    if (socket.data.roomId && socket.data.roomId !== requestedId) leaveRoom(socket);

    const room = existing || (rooms[requestedId] = createRoom(requestedId, password));
    room.emptySince = null;

    socket.join(requestedId);
    socket.data.roomId = requestedId;
    socket.data.name = name;
    room.users.set(socket.id, {
      name,
      color: pickColor(room),
      buffering: false,
      synced: true
    });
    ensureHost(room);

    socket.emit('room:joined', {
      ...publicRoom(room),
      you: { id: socket.id, name, isHost: socket.id === room.hostId }
    });
    broadcastUsers(requestedId, room);
    pushMessage(room, requestedId, {
      name: 'Sistema',
      system: true,
      text: `${name} se unió a la sala.`
    });
  });

  socket.on('chat:send', (payload) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || !rateLimit(socket, 'chat', 12, 3000)) return;

    const text = String((payload && payload.text) || payload || '').trim().slice(0, 400);
    if (!text) return;

    pushMessage(room, roomId, {
      name: socket.data.name,
      color: (room.users.get(socket.id) || {}).color,
      text,
      system: false
    });
  });

  socket.on('playback:command', (payload = {}) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || !room.video || !rateLimit(socket, 'command', 40, 2000)) return;

    const action = String(payload.action || '');
    const nowPosition = playbackOf(room).position;
    const p = room.playback;

    switch (action) {
      case 'play':
        p.position = nowPosition;
        p.playing = true;
        break;
      case 'pause':
        p.position = nowPosition;
        p.playing = false;
        break;
      case 'seek':
        p.position = clampNumber(payload.time, 0, MAX_POSITION, nowPosition);
        break;
      case 'rate':
        p.position = nowPosition;
        p.rate = clampNumber(payload.rate, 0.5, 2, 1);
        break;
      case 'ended':
        p.position = 0;
        p.playing = false;
        break;
      default:
        return;
    }

    emitPlayback(roomId, room, action);
  });

  socket.on('video:set', (payload) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || !rateLimit(socket, 'video', 8, 10000)) return;

    const raw = typeof payload === 'string' ? payload : payload && payload.url;
    const url = sanitizeUrl(raw);
    if (!url) {
      socket.emit('room:error', 'Ese link no es válido. Pegá un link de YouTube, .mp4 o .m3u8.');
      return;
    }

    room.video = detectVideoType(url);
    room.playback = { position: 0, playing: false, rate: 1, updatedAt: Date.now() };
    room.revision += 1;

    io.to(roomId).emit('video:changed', {
      video: room.video,
      playback: playbackOf(room),
      by: socket.data.name
    });
  });

  socket.on('peer:state', (payload = {}) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user) return;

    const buffering = !!payload.buffering;
    const synced = payload.synced !== false;
    if (user.buffering === buffering && user.synced === synced) return;
    user.buffering = buffering;
    user.synced = synced;
    broadcastUsers(roomId, room);
  });

  socket.on('sync:request', () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room) return;
    socket.emit('sync:state', publicRoom(room));
  });

  socket.on('room:leave', () => leaveRoom(socket));

  socket.on('disconnect', () => leaveRoom(socket));
});

// Tick global: una sola fuente de verdad para todas las salas.
setInterval(() => {
  for (const room of Object.values(rooms)) {
    if (room.users.size === 0) continue;
    io.to(room.id).emit('sync:tick', playbackOf(room));
  }
}, TICK_MS);

// Limpieza de salas abandonadas (así una recarga no pierde el video).
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of Object.entries(rooms)) {
    if (room.users.size === 0 && room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL) {
      delete rooms[id];
    }
  }
}, 60 * 1000);

app.set('trust proxy', 1);

const PORT = Number(process.env.PORT) || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`SyncRoom listo en http://0.0.0.0:${PORT}`);
});
