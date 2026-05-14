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

// Serve index for any route (SPA-style)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Generate a new room ID
app.get('/create-room', (req, res) => {
  const roomId = uuidv4().slice(0, 8).toUpperCase();
  res.json({ roomId });
});

// Track rooms and their participants
const rooms = {}; // roomId -> { socketId -> { id, name, micOn, cameraOn } }

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // User joins a room
  socket.on('join-room', ({ roomId, userName, micOn, cameraOn }) => {
    socket.join(roomId);

    if (!rooms[roomId]) rooms[roomId] = {};
    rooms[roomId][socket.id] = { id: socket.id, name: userName, micOn, cameraOn };

    // Tell the new user about existing participants
    const existingPeers = Object.values(rooms[roomId]).filter(p => p.id !== socket.id);
    socket.emit('room-peers', { peers: existingPeers });

    // Tell existing peers about the new user
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

  // WebRTC signaling: offer
  socket.on('offer', ({ targetId, offer }) => {
    io.to(targetId).emit('offer', {
      fromId: socket.id,
      fromName: socket.userName,
      offer
    });
  });

  // WebRTC signaling: answer
  socket.on('answer', ({ targetId, answer }) => {
    io.to(targetId).emit('answer', {
      fromId: socket.id,
      answer
    });
  });

  // WebRTC signaling: ICE candidate
  socket.on('ice-candidate', ({ targetId, candidate }) => {
    io.to(targetId).emit('ice-candidate', {
      fromId: socket.id,
      candidate
    });
  });

  // Media state toggle (mic / camera)
  socket.on('media-state', ({ micOn, cameraOn }) => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId] && rooms[roomId][socket.id]) {
      rooms[roomId][socket.id].micOn = micOn;
      rooms[roomId][socket.id].cameraOn = cameraOn;
    }
    socket.to(socket.roomId).emit('peer-media-state', {
      peerId: socket.id,
      micOn,
      cameraOn
    });
  });

  // Disconnect
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
