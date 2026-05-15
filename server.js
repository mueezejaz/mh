const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/create-room', (req, res) => {
  const roomId = uuidv4().slice(0, 8).toUpperCase();
  res.json({ roomId });
});

const rooms = {}; // roomId -> { socketId -> { id, name, micOn, cameraOn } }

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  socket.on('join-room', ({ roomId, userName, micOn, cameraOn }) => {
    socket.join(roomId);

    if (!rooms[roomId]) rooms[roomId] = {};
    rooms[roomId][socket.id] = { id: socket.id, name: userName, micOn, cameraOn };

    const existingPeers = Object.values(rooms[roomId]).filter(p => p.id !== socket.id);
    socket.emit('room-peers', { peers: existingPeers });

    socket.to(roomId).emit('peer-joined', {
      peerId: socket.id,
      name: userName,
      micOn,
      cameraOn
    });

    socket.roomId = roomId;
    socket.userName = userName;
    console.log(`[~] ${userName} joined room ${roomId}`);
  });

  socket.on('offer', ({ targetId, offer, isPolite }) => {
    io.to(targetId).emit('offer', {
      fromId: socket.id,
      fromName: socket.userName,
      offer,
      isPolite   // ← forward the polite flag the client sends
    });
  });

  socket.on('answer', ({ targetId, answer }) => {
    io.to(targetId).emit('answer', {
      fromId: socket.id,
      answer
    });
  });

  socket.on('ice-candidate', ({ targetId, candidate }) => {
    io.to(targetId).emit('ice-candidate', {
      fromId: socket.id,
      candidate
    });
  });

  socket.on('media-state', ({ micOn, cameraOn }) => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId] && rooms[roomId][socket.id]) {
      rooms[roomId][socket.id].micOn = micOn;
      rooms[roomId][socket.id].cameraOn = cameraOn;
    }
    socket.to(roomId).emit('peer-media-state', {
      peerId: socket.id,
      micOn,
      cameraOn
    });
  });

  // ── Screen share signaling ──────────────────────────────────────────────
  // BUG FIX: server MUST forward these events to room peers so receivers
  // can populate state.peerScreenStreams[peerId] before ontrack fires.
  // Without this, ontrack never knows the incoming stream is a screen share
  // and attaches it to the camera tile instead of creating a new screen tile.

  socket.on('screen-share-started', ({ streamId }) => {
    socket.to(socket.roomId).emit('peer-screen-share', {
      peerId: socket.id,
      streamId,
      sharing: true,
    });
    console.log(`[~] ${socket.userName} started screen share (stream: ${streamId})`);
  });

  socket.on('screen-share-stopped', () => {
    socket.to(socket.roomId).emit('peer-screen-share', {
      peerId: socket.id,
      streamId: null,
      sharing: false,
    });
    console.log(`[~] ${socket.userName} stopped screen share`);
  });
  // ───────────────────────────────────────────────────────────────────────

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      delete rooms[roomId][socket.id];
      if (Object.keys(rooms[roomId]).length === 0) delete rooms[roomId];
    }
    io.to(roomId).emit('peer-left', { peerId: socket.id });
    console.log(`[-] Disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 WebRTC Conference Server running at http://localhost:${PORT}\n`);
});