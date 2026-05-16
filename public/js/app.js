/* ══════════════════════════════════════════
   NexMeet — WebRTC Conference App
   ══════════════════════════════════════════ */

const socket = io();

// ── State ──────────────────────────────────
const state = {
  roomId: null,
  userName: null,
  localStream: null,
  screenStream: null,
  isSharing: false,
  micOn: true,
  cameraOn: true,
  selectedMicId: null,
  audioDevices: [],
  peers: {},
  peerNames: {},
  peerMedia: {},
  // peerId -> { streamId, stream }
  // Populated when we receive peer-screen-share signal (may arrive before or after ontrack)
  peerScreenInfo: {},
  pendingStreams: {},   // peerId -> { streamId -> MediaStream } buffered before signal
  startTime: null,
  timerInterval: null,
  makingOffer: {},
  ignoreOffer: {},
};

const initiatedPeers = new Set();

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ]
};

const $ = (id) => document.getElementById(id);
const screens = { lobby: $('lobby'), prejoin: $('prejoin'), conference: $('conference') };

// ══════════════════════════════════════════
// Screen Management
// ══════════════════════════════════════════
function showScreen(name) {
  Object.entries(screens).forEach(([k, el]) => {
    el.classList.toggle('active', k === name);
  });
}

// ══════════════════════════════════════════
// LOBBY
// ══════════════════════════════════════════
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

$('btn-create').addEventListener('click', async () => {
  const name = $('create-name').value.trim();
  if (!name) { showToast('Please enter your name'); return; }
  try {
    const res = await fetch('/create-room');
    const { roomId } = await res.json();
    await enterPrejoin(name, roomId);
  } catch (e) { showToast('Failed to create room'); }
});

$('btn-join').addEventListener('click', async () => {
  const name = $('join-name').value.trim();
  const room = $('join-room').value.trim().toUpperCase();
  if (!name) { showToast('Please enter your name'); return; }
  if (!room) { showToast('Please enter a room code'); return; }
  await enterPrejoin(name, room);
});

// ══════════════════════════════════════════
// PRE-JOIN
// ══════════════════════════════════════════
async function enterPrejoin(name, roomId) {
  state.userName = name;
  state.roomId = roomId;
  state.micOn = true;
  state.cameraOn = true;
  $('pj-room-label').textContent = `Room: ${roomId}`;
  $('preview-avatar-letter').textContent = name[0].toUpperCase();
  showScreen('prejoin');
  await startPreviewStream();
  await populateMicDevices('pj-mic-select');
}

async function startPreviewStream(micDeviceId = null) {
  if (state.localStream) {
    state.localStream.getTracks().forEach(t => t.stop());
    state.localStream = null;
  }
  try {
    const audioConstraint = micDeviceId
      ? { deviceId: { exact: micDeviceId } }
      : true;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: audioConstraint,
    });
    state.localStream = stream;
    $('preview-video').srcObject = stream;
    stream.getAudioTracks().forEach(t => t.enabled = state.micOn);
    stream.getVideoTracks().forEach(t => t.enabled = state.cameraOn);
    updatePrejoinUI();
  } catch (e) {
    showToast('Could not access camera/mic: ' + e.message);
    state.cameraOn = false;
    state.micOn = false;
    updatePrejoinUI();
  }
}

async function populateMicDevices(selectId) {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    state.audioDevices = devices.filter(d => d.kind === 'audioinput');
    const sel = $(selectId);
    if (!sel) return;
    sel.innerHTML = '';
    if (state.audioDevices.length === 0) {
      sel.innerHTML = '<option value="">No microphones found</option>';
      return;
    }
    state.audioDevices.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Microphone ${i + 1}`;
      if (d.deviceId === state.selectedMicId) opt.selected = true;
      sel.appendChild(opt);
    });
    if (!state.selectedMicId) {
      state.selectedMicId = state.audioDevices[0]?.deviceId || null;
    }
  } catch (e) {
    console.warn('Could not enumerate devices:', e);
  }
}

function updatePrejoinUI() {
  const micBtn = $('pj-mic-btn');
  const camBtn = $('pj-cam-btn');
  const preview = $('preview-video');
  const avatar = $('preview-avatar');
  const camOffLabel = $('pj-cam-off-label');

  micBtn.className = 'pj-ctrl-btn ' + (state.micOn ? 'active' : 'off');
  micBtn.querySelector('span').textContent = state.micOn ? 'Mic On' : 'Mic Off';
  camBtn.className = 'pj-ctrl-btn ' + (state.cameraOn ? 'active' : 'off');
  camBtn.querySelector('span').textContent = state.cameraOn ? 'Cam On' : 'Cam Off';

  if (state.localStream) {
    state.localStream.getAudioTracks().forEach(t => t.enabled = state.micOn);
    state.localStream.getVideoTracks().forEach(t => t.enabled = state.cameraOn);
  }

  if (state.cameraOn && state.localStream?.getVideoTracks().length) {
    preview.classList.remove('hidden');
    avatar.classList.add('hidden');
    camOffLabel.classList.add('hidden');
  } else {
    preview.classList.add('hidden');
    avatar.classList.remove('hidden');
    camOffLabel.classList.remove('hidden');
  }
}

$('pj-mic-btn').addEventListener('click', () => { state.micOn = !state.micOn; updatePrejoinUI(); });
$('pj-cam-btn').addEventListener('click', () => { state.cameraOn = !state.cameraOn; updatePrejoinUI(); });
$('pj-mic-select').addEventListener('change', async (e) => {
  state.selectedMicId = e.target.value;
  await startPreviewStream(state.selectedMicId);
});
$('pj-cancel').addEventListener('click', () => { stopLocalStream(); showScreen('lobby'); });
$('pj-enter').addEventListener('click', () => joinConference());

// ══════════════════════════════════════════
// JOIN CONFERENCE
// ══════════════════════════════════════════
async function joinConference() {
  if (!state.localStream) {
    try {
      const audioConstraint = state.selectedMicId
        ? { deviceId: { exact: state.selectedMicId } }
        : true;
      state.localStream = await navigator.mediaDevices.getUserMedia({
        video: true, audio: audioConstraint,
      });
    } catch (e) {
      showToast('No media devices — joining without A/V');
    }
  }

  showScreen('conference');
  $('conf-room-id').textContent = state.roomId;
  addVideoTile('local', state.userName, state.localStream, true);
  updateGridClass();
  state.startTime = Date.now();
  state.timerInterval = setInterval(updateTimer, 1000);

  socket.emit('join-room', {
    roomId: state.roomId,
    userName: state.userName,
    micOn: state.micOn,
    cameraOn: state.cameraOn,
  });
}

// ══════════════════════════════════════════
// SIGNALING — Perfect Negotiation Pattern
// ══════════════════════════════════════════

socket.on('room-peers', async ({ peers }) => {
  for (const peer of peers) {
    state.peerNames[peer.id] = peer.name;
    state.peerMedia[peer.id] = { micOn: peer.micOn, cameraOn: peer.cameraOn };
    await createPeerConnection(peer.id, true);
  }
});

socket.on('peer-joined', ({ peerId, name, micOn, cameraOn }) => {
  state.peerNames[peerId] = name;
  state.peerMedia[peerId] = { micOn, cameraOn };
  showToast(`${name} joined`);
});

socket.on('offer', async ({ fromId, fromName, offer, isPolite: senderIsPolite }) => {
  if (!state.peers[fromId]) {
    state.peerNames[fromId] = fromName;
    await createPeerConnection(fromId, false);
  }

  const pc = state.peers[fromId];
  const offerCollision = (pc.signalingState !== 'stable') || state.makingOffer[fromId];
  const weArePolite = !senderIsPolite;

  state.ignoreOffer[fromId] = !weArePolite && offerCollision;
  if (state.ignoreOffer[fromId]) {
    console.log(`[negotiation] Ignoring colliding offer from ${fromId} (we are impolite)`);
    return;
  }

  try {
    if (offerCollision && weArePolite) {
      await pc.setLocalDescription({ type: 'rollback' });
    }
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { targetId: fromId, answer });
  } catch (e) {
    console.error('Error handling offer:', e);
  }
});

socket.on('answer', async ({ fromId, answer }) => {
  const pc = state.peers[fromId];
  if (!pc) return;
  if (state.ignoreOffer[fromId]) return;
  try {
    if (pc.signalingState === 'have-local-offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
  } catch (e) {
    console.error('Error handling answer:', e);
  }
});

socket.on('ice-candidate', async ({ fromId, candidate }) => {
  const pc = state.peers[fromId];
  if (pc && candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      if (!state.ignoreOffer[fromId]) console.error('ICE error:', e);
    }
  }
});

socket.on('peer-media-state', ({ peerId, micOn, cameraOn }) => {
  state.peerMedia[peerId] = { micOn, cameraOn };
  updateTileBadges(peerId, micOn, cameraOn);
});

// ── Screen share signal from server ────────────────────────────────────────
// BUG FIX: This event was emitted by the sharer but the server never
// forwarded it, so receivers never knew which stream ID was the screen.
// Now the server forwards it and we store it in state.peerScreenInfo.
//
// RACE CONDITION FIX: The signal and the WebRTC track (ontrack) can arrive
// in either order depending on network timing:
//   - Signal first → store streamId, ontrack uses it to create screen tile ✓
//   - Track first  → ontrack stores the stream, signal triggers tile creation ✓
socket.on('peer-screen-share', ({ peerId, streamId, sharing }) => {
  if (sharing) {
    // Record that this peer is sharing streamId
    state.peerScreenInfo[peerId] = { streamId, stream: null };

    // Check if ontrack already buffered this stream (track arrived before signal)
    const buffered = state.pendingStreams[peerId]?.[streamId];
    if (buffered) {
      state.peerScreenInfo[peerId].stream = buffered;
      ensureScreenTile(peerId, buffered);
    }
    // Otherwise ontrack will fire later, see the matching streamId, and call ensureScreenTile
  } else {
    // Sharer stopped — clean up
    delete state.peerScreenInfo[peerId];
    if (state.pendingStreams[peerId]) {
      // Clear any buffered screen stream so it doesn't ghost on next share
      Object.keys(state.pendingStreams[peerId]).forEach(sid => {
        delete state.pendingStreams[peerId][sid];
      });
    }
    const tile = $(`tile-screen-${peerId}`);
    if (tile) tile.remove();
    updateGridClass();
  }
});

socket.on('peer-left', ({ peerId }) => {
  showToast(`${state.peerNames[peerId] || 'Someone'} left`);
  removePeer(peerId);
});

// ══════════════════════════════════════════
// Screen tile helpers
// ══════════════════════════════════════════

/**
 * Called when BOTH the signal (streamId known) AND the track (stream known)
 * are available. Creates the screen tile if needed and always sets the stream.
 */
function ensureScreenTile(peerId, stream) {
  const tileId = `screen-${peerId}`;
  let tile = $(`tile-${tileId}`);

  if (!tile) {
    const name = state.peerNames[peerId] || 'Peer';
    addVideoTile(tileId, name, stream, false, true);
    tile = $(`tile-${tileId}`);
  }

  // Always (re)attach the stream — tile may exist from a prior share attempt
  // and also hide the avatar so the video is visible
  if (tile) {
    const video = tile.querySelector('video');
    if (video && video.srcObject !== stream) {
      video.srcObject = stream;
      video.play().catch(() => { });
    }
    // Screen tiles never show the avatar — hide it unconditionally
    const avatar = tile.querySelector('.tile-avatar');
    if (avatar) avatar.style.display = 'none';
  }

  updateGridClass();
}

// ══════════════════════════════════════════
// RTCPeerConnection
// ══════════════════════════════════════════
async function createPeerConnection(peerId, isInitiator) {
  if (state.peers[peerId]) return state.peers[peerId];

  if (isInitiator) initiatedPeers.add(peerId);

  const pc = new RTCPeerConnection(ICE_CONFIG);
  state.peers[peerId] = pc;
  state.makingOffer[peerId] = false;
  state.ignoreOffer[peerId] = false;

  if (state.localStream) {
    state.localStream.getTracks().forEach(track => {
      pc.addTrack(track, state.localStream);
    });
  }

  if (state.screenStream) {
    state.screenStream.getTracks().forEach(track => {
      pc.addTrack(track, state.screenStream);
    });
  }

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('ice-candidate', { targetId: peerId, candidate });
  };

  pc.onnegotiationneeded = async () => {
    if (pc.signalingState !== 'stable') return;
    if (state.makingOffer[peerId]) return;

    try {
      state.makingOffer[peerId] = true;
      const offer = await pc.createOffer();
      if (pc.signalingState !== 'stable') return;
      await pc.setLocalDescription(offer);
      socket.emit('offer', {
        targetId: peerId,
        offer,
        isPolite: !isInitiator,
      });
    } catch (e) {
      console.error('onnegotiationneeded error:', e);
    } finally {
      state.makingOffer[peerId] = false;
    }
  };

  // ─── ontrack ───────────────────────────────────────────────────────────
  // Every incoming stream is stored in state.pendingStreams[peerId][stream.id].
  // When peer-screen-share signal arrives with a streamId, we look up the
  // buffered stream and call ensureScreenTile. This avoids ALL heuristics
  // (track count, audio presence) which are unreliable on mobile browsers.
  pc.ontrack = ({ streams }) => {
    const stream = streams[0];
    if (!stream) return;

    // Buffer every stream by its id — the signal handler resolves which is screen
    if (!state.pendingStreams[peerId]) state.pendingStreams[peerId] = {};
    state.pendingStreams[peerId][stream.id] = stream;

    // Case A: peer-screen-share signal already arrived for this stream
    const info = state.peerScreenInfo[peerId];
    if (info && info.streamId === stream.id) {
      info.stream = stream;
      ensureScreenTile(peerId, stream);
      return;
    }

    // Case B: peer has no camera tile yet — first stream is camera/mic
    const existingCameraTile = $(`tile-${peerId}`);
    if (!existingCameraTile) {
      const name = state.peerNames[peerId] || 'Peer';
      const media = state.peerMedia[peerId] || { micOn: true, cameraOn: true };
      addVideoTile(peerId, name, null, false, false);
      const tile = $(`tile-${peerId}`);
      if (tile) {
        const video = tile.querySelector('video');
        if (video) { video.srcObject = stream; video.play().catch(() => { }); }
        const avatar = tile.querySelector('.tile-avatar');
        if (avatar) avatar.style.display = 'none';
      }
      updateTileBadges(peerId, media.micOn, media.cameraOn);
      updateGridClass();
      return;
    }

    // Case C: camera tile exists and this stream doesn't match a known screen signal yet.
    // It's already buffered above — peer-screen-share handler will pick it up.
  };

  pc.onconnectionstatechange = () => {
    console.log(`Peer ${peerId}: ${pc.connectionState}`);
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      removePeer(peerId);
    }
  };

  return pc;
}

function removePeer(peerId) {
  if (state.peers[peerId]) {
    state.peers[peerId].close();
    delete state.peers[peerId];
  }
  initiatedPeers.delete(peerId);
  delete state.peerNames[peerId];
  delete state.peerMedia[peerId];
  delete state.peerScreenInfo[peerId];
  delete state.pendingStreams[peerId];
  delete state.makingOffer[peerId];
  delete state.ignoreOffer[peerId];

  const tile = document.getElementById(`tile-${peerId}`);
  if (tile) tile.remove();
  const screenTile = document.getElementById(`tile-screen-${peerId}`);
  if (screenTile) screenTile.remove();
  updateGridClass();
}

// ══════════════════════════════════════════
// SCREEN SHARE
// ══════════════════════════════════════════
$('btn-share').addEventListener('click', async () => {
  if (state.isSharing) {
    await stopScreenShare();
  } else {
    await startScreenShare();
  }
});

async function startScreenShare() {
  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 30, max: 60 },
        width: { ideal: 1280, max: 1280 },
        height: { ideal: 720, max: 720 },
        cursor: 'always',
        displaySurface: 'monitor',
      },
      audio: false,
    });

    state.screenStream = screenStream;
    state.isSharing = true;

    const screenTrack = screenStream.getVideoTracks()[0];

    addVideoTile('screen-local', `${state.userName}'s Screen`, screenStream, true, true);

    // Emit BEFORE adding tracks so receivers register the streamId before
    // the renegotiated offer+track arrives (reduces race window)
    socket.emit('screen-share-started', { streamId: screenStream.id });

    for (const [peerId, pc] of Object.entries(state.peers)) {
      try {
        const sender = pc.addTrack(screenTrack, screenStream);

        const params = sender.getParameters();
        if (params.encodings && params.encodings.length > 0) {
          params.encodings.forEach(enc => {
            enc.priority = 'high';
            enc.networkPriority = 'high';
            delete enc.maxBitrate;
          });
          await sender.setParameters(params).catch(() => { });
        }
      } catch (e) {
        console.error('Error adding screen track for peer', peerId, e);
      }
    }

    screenTrack.onended = () => stopScreenShare();
    updateShareButton(true);
    showToast('Screen sharing started');
  } catch (e) {
    if (e.name !== 'NotAllowedError') showToast('Screen share failed: ' + e.message);
  }
}

async function stopScreenShare() {
  if (!state.screenStream) return;

  for (const pc of Object.values(state.peers)) {
    const senders = pc.getSenders().filter(s =>
      s.track && state.screenStream.getTracks().includes(s.track)
    );
    for (const sender of senders) {
      try { pc.removeTrack(sender); } catch (e) { }
    }
  }

  state.screenStream.getTracks().forEach(t => t.stop());
  state.screenStream = null;
  state.isSharing = false;

  const tile = $('tile-screen-local');
  if (tile) tile.remove();
  updateGridClass();

  socket.emit('screen-share-stopped');
  updateShareButton(false);
  showToast('Screen sharing stopped');
}

function updateShareButton(sharing) {
  const btn = $('btn-share');
  btn.className = 'ctrl-btn ' + (sharing ? 'sharing' : '');
  $('share-label').textContent = sharing ? 'Stop Share' : 'Share';
  btn.querySelector('.ic-share').classList.toggle('hidden', sharing);
  btn.querySelector('.ic-share-stop').classList.toggle('hidden', !sharing);
}

// ══════════════════════════════════════════
// VIDEO TILES
// ══════════════════════════════════════════
function addVideoTile(id, name, stream, isLocal, isScreen = false) {
  const grid = $('video-grid');
  if (document.getElementById(`tile-${id}`)) return;

  const tile = document.createElement('div');
  const cls = ['video-tile'];
  if (isLocal && !isScreen) cls.push('local');
  if (isScreen) cls.push('screen-tile');
  tile.className = cls.join(' ');
  tile.id = `tile-${id}`;

  const initial = name ? name[0].toUpperCase() : '?';

  tile.innerHTML = `
    <video autoplay ${isLocal && !isScreen ? 'muted' : ''} playsinline></video>
    <div class="tile-avatar">
      <div class="avatar-circle">${initial}</div>
      <span class="peer-name-big">${name}</span>
    </div>
    <div class="tile-overlay">
      <span class="tile-name">${name}${isLocal && !isScreen ? ' (You)' : isScreen ? ' (Screen)' : ''}</span>
      <div class="tile-badge" id="badge-${id}">${isScreen ? '<span class="screen-badge">Screen</span>' : ''}</div>
    </div>
    <div class="tile-actions">
      <button class="tile-btn" title="Fullscreen" onclick="toggleTileFullscreen('${id}')">
        <svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
      </button>
    </div>
  `;

  const video = tile.querySelector('video');
  const avatar = tile.querySelector('.tile-avatar');

  if (stream) {
    video.srcObject = stream;
    video.play().catch(() => { });
    // Hide the avatar whenever we already have a live stream at creation time
    // (covers screen tiles and remote camera tiles with stream known upfront)
    if (avatar) avatar.style.display = 'none';
  }

  grid.appendChild(tile);
  updateGridClass();

  if (isLocal && !isScreen) {
    // Local tile: let camera state control the avatar
    updateLocalTileAvatar(tile, state.cameraOn);
    updateTileBadges('local', state.micOn, state.cameraOn);
  }
}

function updateLocalTileAvatar(tile, cameraOn) {
  const avatar = tile.querySelector('.tile-avatar');
  if (avatar) avatar.style.display = cameraOn ? 'none' : 'flex';
}

function updateTileBadges(id, micOn, cameraOn) {
  const badge = $(`badge-${id}`);
  if (!badge) return;
  const screenBadge = badge.querySelector('.screen-badge');
  badge.innerHTML = '';
  if (screenBadge) badge.appendChild(screenBadge);

  if (!micOn) {
    const el = document.createElement('div');
    el.className = 'badge-icon';
    el.title = 'Mic off';
    el.innerHTML = `<svg viewBox="0 0 24 24"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;
    badge.appendChild(el);
  }
  if (!cameraOn) {
    const el = document.createElement('div');
    el.className = 'badge-icon';
    el.title = 'Camera off';
    el.style.background = 'rgba(255,184,48,0.8)';
    el.innerHTML = `<svg viewBox="0 0 24 24"><line x1="1" y1="1" x2="23" y2="23"/><path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h1a2 2 0 0 1 2 2v9.34"/><path d="M16 11.37A4 4 0 1 1 12.63 8"/></svg>`;
    badge.appendChild(el);
  }

  const tile = $(`tile-${id}`);
  if (tile && id !== 'local') {
    const avatar = tile.querySelector('.tile-avatar');
    if (avatar) avatar.style.display = cameraOn ? 'none' : 'flex';
  }
}

function updateGridClass() {
  const grid = $('video-grid');
  const count = grid.querySelectorAll('.video-tile').length;
  grid.className = 'video-grid';
  grid.classList.add(count <= 6 ? `grid-${count}` : 'grid-many');
}

// ══════════════════════════════════════════
// FULLSCREEN PER TILE
// ══════════════════════════════════════════
let currentFullscreen = null;

async function toggleTileFullscreen(id) {
  const tile = $(`tile-${id}`);
  if (!tile) return;

  if (currentFullscreen === id) {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      try {
        const exitFn = document.exitFullscreen || document.webkitExitFullscreen;
        if (exitFn) await exitFn.call(document);
      } catch (e) { }
    }
    try {
      if (screen.orientation && screen.orientation.unlock) {
        screen.orientation.unlock();
      }
    } catch (e) { }
    return;
  }

  if (currentFullscreen) {
    const prev = $(`tile-${currentFullscreen}`);
    if (prev) setFullscreenIcon(prev, false);
  }

  currentFullscreen = id;
  setFullscreenIcon(tile, true);

  try {
    const requestFn = tile.requestFullscreen
      || tile.webkitRequestFullscreen
      || tile.mozRequestFullScreen
      || tile.msRequestFullscreen;

    if (requestFn) {
      await requestFn.call(tile, { navigationUI: 'hide' });
    }
  } catch (e) {
    tile.classList.add('fullscreen-css');
  }

  try {
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock('landscape');
    }
  } catch (e) { }
}

function handleFullscreenChange() {
  const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
  if (!isFullscreen && currentFullscreen) {
    const tile = $(`tile-${currentFullscreen}`);
    if (tile) {
      tile.classList.remove('fullscreen-css');
      setFullscreenIcon(tile, false);
    }
    try {
      if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
    } catch (e) { }
    currentFullscreen = null;
  }
}
document.addEventListener('fullscreenchange', handleFullscreenChange);
document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
document.addEventListener('mozfullscreenchange', handleFullscreenChange);
document.addEventListener('MSFullscreenChange', handleFullscreenChange);

function setFullscreenIcon(tile, isFullscreen) {
  const btn = tile.querySelector('.tile-btn');
  if (!btn) return;
  btn.title = isFullscreen ? 'Exit Fullscreen' : 'Fullscreen';
  btn.querySelector('svg').innerHTML = isFullscreen
    ? '<path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>'
    : '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>';
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && currentFullscreen) toggleTileFullscreen(currentFullscreen);
});

// ══════════════════════════════════════════
// CONTROL BAR — MIC
// ══════════════════════════════════════════
$('btn-mic').addEventListener('click', () => {
  state.micOn = !state.micOn;
  if (state.localStream) state.localStream.getAudioTracks().forEach(t => t.enabled = state.micOn);
  updateControlBar();
  updateTileBadges('local', state.micOn, state.cameraOn);
  socket.emit('media-state', { micOn: state.micOn, cameraOn: state.cameraOn });
});

// ══════════════════════════════════════════
// MIC PICKER POPUP
// ══════════════════════════════════════════
$('btn-mic-picker').addEventListener('click', async (e) => {
  e.stopPropagation();
  const picker = $('mic-picker');
  const chevron = $('btn-mic-picker');
  const isOpen = !picker.classList.contains('hidden');
  if (isOpen) {
    picker.classList.add('hidden');
    chevron.classList.remove('open');
    return;
  }
  await refreshMicPickerList();
  picker.classList.remove('hidden');
  chevron.classList.add('open');
});

document.addEventListener('click', (e) => {
  const picker = $('mic-picker');
  const btn = $('btn-mic-picker');
  if (!picker.contains(e.target) && e.target !== btn) {
    picker.classList.add('hidden');
    $('btn-mic-picker').classList.remove('open');
  }
});

async function refreshMicPickerList() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    state.audioDevices = devices.filter(d => d.kind === 'audioinput');
  } catch (e) { }

  const list = $('mic-list');
  list.innerHTML = '';
  if (state.audioDevices.length === 0) {
    list.innerHTML = '<li class="mic-item" style="color:var(--muted)">No microphones found</li>';
    return;
  }
  state.audioDevices.forEach((device, i) => {
    const li = document.createElement('li');
    li.className = 'mic-item' + (device.deviceId === state.selectedMicId ? ' selected' : '');
    li.dataset.deviceId = device.deviceId;
    const label = device.label || `Microphone ${i + 1}`;
    li.innerHTML = `
      <svg viewBox="0 0 24 24"><path d="M12 1a4 4 0 0 1 4 4v7a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
      <span class="mic-name" title="${label}">${label}</span>
      <div class="mic-check"></div>
    `;
    li.addEventListener('click', () => selectMicDevice(device.deviceId));
    list.appendChild(li);
  });
}

async function selectMicDevice(deviceId) {
  if (deviceId === state.selectedMicId) {
    $('mic-picker').classList.add('hidden');
    $('btn-mic-picker').classList.remove('open');
    return;
  }
  state.selectedMicId = deviceId;
  showToast('Switching microphone…');
  try {
    const newAudioStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId } }, video: false,
    });
    const newAudioTrack = newAudioStream.getAudioTracks()[0];
    if (!newAudioTrack) throw new Error('No audio track');
    newAudioTrack.enabled = state.micOn;
    if (state.localStream) {
      const oldTracks = state.localStream.getAudioTracks();
      oldTracks.forEach(t => { state.localStream.removeTrack(t); t.stop(); });
      state.localStream.addTrack(newAudioTrack);
    } else {
      state.localStream = newAudioStream;
    }
    for (const pc of Object.values(state.peers)) {
      const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
      if (sender) await sender.replaceTrack(newAudioTrack);
    }
    const deviceName = state.audioDevices.find(d => d.deviceId === deviceId)?.label || 'Microphone';
    showToast(`Mic: ${deviceName.slice(0, 30)}`);
  } catch (e) {
    showToast('Failed to switch microphone: ' + e.message);
  }
  await refreshMicPickerList();
  $('mic-picker').classList.add('hidden');
  $('btn-mic-picker').classList.remove('open');
}

// ══════════════════════════════════════════
// CONTROL BAR — CAMERA
// ══════════════════════════════════════════
$('btn-cam').addEventListener('click', () => {
  state.cameraOn = !state.cameraOn;
  if (state.localStream) state.localStream.getVideoTracks().forEach(t => t.enabled = state.cameraOn);
  updateControlBar();
  updateTileBadges('local', state.micOn, state.cameraOn);
  const localTile = $('tile-local');
  if (localTile) updateLocalTileAvatar(localTile, state.cameraOn);
  socket.emit('media-state', { micOn: state.micOn, cameraOn: state.cameraOn });
});

function updateControlBar() {
  const micBtn = $('btn-mic');
  const camBtn = $('btn-cam');
  micBtn.className = 'ctrl-btn ' + (state.micOn ? 'active' : 'off');
  $('mic-label').textContent = state.micOn ? 'Mute' : 'Unmute';
  micBtn.querySelector('.ic-mic').classList.toggle('hidden', !state.micOn);
  micBtn.querySelector('.ic-mic-off').classList.toggle('hidden', state.micOn);
  camBtn.className = 'ctrl-btn ' + (state.cameraOn ? 'active' : 'off');
  $('cam-label').textContent = state.cameraOn ? 'Stop Video' : 'Start Video';
  camBtn.querySelector('.ic-cam').classList.toggle('hidden', !state.cameraOn);
  camBtn.querySelector('.ic-cam-off').classList.toggle('hidden', state.cameraOn);
}

// ══════════════════════════════════════════
// LEAVE
// ══════════════════════════════════════════
$('btn-leave').addEventListener('click', leaveConference);

function leaveConference() {
  if (state.isSharing) stopScreenShare();
  stopLocalStream();
  Object.keys(state.peers).forEach(id => { state.peers[id].close(); delete state.peers[id]; });
  socket.disconnect();
  clearInterval(state.timerInterval);
  $('video-grid').innerHTML = '';
  state.roomId = null;
  state.userName = null;
  setTimeout(() => location.reload(), 100);
}

function stopLocalStream() {
  if (state.localStream) { state.localStream.getTracks().forEach(t => t.stop()); state.localStream = null; }
}

// ══════════════════════════════════════════
// TIMER
// ══════════════════════════════════════════
function updateTimer() {
  const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  const parts = h > 0 ? [h, pad(m), pad(s)] : [pad(m), pad(s)];
  $('conf-time').textContent = parts.join(':');
}
const pad = (n) => String(n).padStart(2, '0');

// ══════════════════════════════════════════
// COPY ROOM CODE
// ══════════════════════════════════════════
$('btn-copy').addEventListener('click', () => {
  navigator.clipboard.writeText($('conf-room-id').textContent)
    .then(() => showToast('Room code copied!'))
    .catch(() => { });
});

// ══════════════════════════════════════════
// TOAST
// ══════════════════════════════════════════
let toastTimer;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}