const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' } // Permite conexiones desde cualquier origen (útil en Render/Railway)
});

// Sirve todo lo que está en /public (index.html, style.css, client.js)
app.use(express.static('public'));

// -----------------------------------------------------------------
// Estado de las salas en memoria.
// rooms = {
//   "mi-sala": {
//     password: "1234" | null,
//     videoUrl: "https://...",
//     currentTime: 0,
//     isPlaying: false,
//     users: Map<socketId, nombre>
//   }
// }
// -----------------------------------------------------------------
const rooms = {};

function sanitizeRoomId(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // saca acentos
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function randomRoomId() {
  return crypto.randomBytes(3).toString('hex'); // ej: "a1b2c3"
}

function getPublicRoomState(room) {
  return {
    videoUrl: room.videoUrl,
    currentTime: room.currentTime,
    isPlaying: room.isPlaying,
    userCount: room.users.size
  };
}

io.on('connection', (socket) => {

  socket.on('join-room', ({ roomId, password, displayName }) => {
    let id = sanitizeRoomId(roomId) || randomRoomId();

    let room = rooms[id];

    // La sala no existe todavía -> se crea en el momento (con la password que hayan puesto)
    if (!room) {
      room = rooms[id] = {
        password: password ? String(password) : null,
        videoUrl: '',
        currentTime: 0,
        isPlaying: false,
        users: new Map()
      };
    } else if (room.password && room.password !== String(password || '')) {
      // La sala existe y tiene contraseña que no coincide
      socket.emit('join-error', 'Contraseña incorrecta para la sala "' + id + '".');
      return;
    }

    socket.join(id);
    socket.data.roomId = id;
    socket.data.displayName = displayName || 'Invitado';
    room.users.set(socket.id, socket.data.displayName);

    // Le mandamos al que se une el estado actual de la sala para que arranque sincronizado
    socket.emit('joined-room', { roomId: id, hasPassword: !!room.password, state: getPublicRoomState(room) });

    // Avisamos a todos (incluido el nuevo) cuántos usuarios hay ahora
    io.to(id).emit('user-count', room.users.size);
  });

  // Reproducir / Pausar / Buscar (seek)
  socket.on('video-action', ({ action, time }) => {
    const id = socket.data.roomId;
    const room = rooms[id];
    if (!room) return;

    room.currentTime = time;
    room.isPlaying = action === 'play' ? true : action === 'pause' ? false : room.isPlaying;

    socket.to(id).emit('video-action', { action, time });
  });

  // Cambio de URL del video, en vivo para todos
  socket.on('change-video', (url) => {
    const id = socket.data.roomId;
    const room = rooms[id];
    if (!room) return;

    room.videoUrl = url;
    room.currentTime = 0;
    room.isPlaying = false;

    io.to(id).emit('video-url-changed', url);
  });

  socket.on('disconnect', () => {
    const id = socket.data.roomId;
    const room = rooms[id];
    if (!room) return;

    room.users.delete(socket.id);
    io.to(id).emit('user-count', room.users.size);

    // Si la sala queda vacía, la borramos para no acumular memoria
    if (room.users.size === 0) {
      delete rooms[id];
    }
  });
});

// process.env.PORT es obligatorio para Render / Railway / Heroku, etc.
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
