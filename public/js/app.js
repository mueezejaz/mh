/* ══════════════════════════════════════════
   NexMeet — WebRTC Conference App
   Fixes:
   - createPeerConnection now properly tracked (isInitiatorForPeer works)
   - onnegotiationneeded fires for ALL peers, not just initiators
   - makingOffer guard checked BEFORE createOffer (not after)
   - isPolite logic corrected (was inverted)
   - peer-screen-share tile removal uses correct tile ID
   - Screen share: high-quality constraints + high RTP priority
   - triggerRenegotiation removed (onnegotiationneeded handles all sides)
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
  peerScreenStreams: {},   // peerId -> streamId of their screen stream
  startTime: null,
  timerInterval: null,
  makingOffer: {},         // peerId -> bool  (perfect negotiation)
  ignoreOffer: {},         // peerId -> bool
};

// Track which peers WE initiated — used for polite/impolite role
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
    await createPeerConnection(peer.id, true);  // we initiate toward existing peers
  }
});

socket.on('peer-joined', ({ peerId, name, micOn, cameraOn }) => {
  state.peerNames[peerId] = name;
  state.peerMedia[peerId] = { micOn, cameraOn };
  showToast(`${name} joined`);
  // New peer sends us an offer — PC is created lazily in the offer handler
});

// ─── Perfect Negotiation: offer handler ───────────────────────────────────
socket.on('offer', async ({ fromId, fromName, offer, isPolite: senderIsPolite }) => {
  if (!state.peers[fromId]) {
    state.peerNames[fromId] = fromName;
    await createPeerConnection(fromId, false);  // they initiated, we didn't
  }

  const pc = state.peers[fromId];
  const offerCollision = (pc.signalingState !== 'stable') || state.makingOffer[fromId];

  // FIX: senderIsPolite tells us about THEM.
  // If they are polite, WE are the impolite side (we were the initiator).
  // If they are impolite, WE are the polite side.
  const weArePolite = !senderIsPolite;

  state.ignoreOffer[fromId] = !weArePolite && offerCollision;
  if (state.ignoreOffer[fromId]) {
    console.log(`[negotiation] Ignoring colliding offer from ${fromId} (we are impolite)`);
    return;
  }

  try {
    if (offerCollision && weArePolite) {
      // Polite side: roll back our pending local offer
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

// Server tells existing peers about a new screen share stream ID
socket.on('peer-screen-share', ({ peerId, streamId, sharing }) => {
  if (sharing) {
    state.peerScreenStreams[peerId] = streamId;
  } else {
    delete state.peerScreenStreams[peerId];
    // FIX: correct tile ID format — tile element id is `tile-screen-${peerId}`
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
// RTCPeerConnection
// ══════════════════════════════════════════
async function createPeerConnection(peerId, isInitiator) {
  if (state.peers[peerId]) return state.peers[peerId];

  // FIX: record initiator role HERE, inside the real function
  if (isInitiator) initiatedPeers.add(peerId);

  const pc = new RTCPeerConnection(ICE_CONFIG);
  state.peers[peerId] = pc;
  state.makingOffer[peerId] = false;
  state.ignoreOffer[peerId] = false;

  // Add all local camera/mic tracks
  if (state.localStream) {
    state.localStream.getTracks().forEach(track => {
      pc.addTrack(track, state.localStream);
    });
  }

  // Add screen share tracks if currently sharing
  if (state.screenStream) {
    state.screenStream.getTracks().forEach(track => {
      pc.addTrack(track, state.screenStream);
    });
  }

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('ice-candidate', { targetId: peerId, candidate });
  };

  // FIX: onnegotiationneeded now fires for ALL peers (not just initiators).
  // Perfect negotiation handles collision — no need to gate on isInitiator.
  // The impolite side (initiator) wins collisions; polite side rolls back.
  pc.onnegotiationneeded = async () => {
    // FIX: guard BEFORE createOffer, not after — prevents setting local
    // description on a non-stable peer and corrupting signaling state
    if (pc.signalingState !== 'stable') return;
    if (state.makingOffer[peerId]) return;

    try {
      state.makingOffer[peerId] = true;
      const offer = await pc.createOffer();
      // Double-check still stable after the async createOffer
      if (pc.signalingState !== 'stable') return;
      await pc.setLocalDescription(offer);
      socket.emit('offer', {
        targetId: peerId,
        offer,
        // isInitiator == impolite (never backs down on collision)
        isPolite: !isInitiator,
      });
    } catch (e) {
      console.error('onnegotiationneeded error:', e);
    } finally {
      state.makingOffer[peerId] = false;
    }
  };

  // ─── ontrack: distinguish camera vs screen streams ────────────────────
  pc.ontrack = ({ track, streams }) => {
    const stream = streams[0];
    if (!stream) return;

    const name = state.peerNames[peerId] || 'Peer';
    const media = state.peerMedia[peerId] || { micOn: true, cameraOn: true };

    const isScreen = state.peerScreenStreams[peerId] === stream.id;
    const tileId = isScreen ? `screen-${peerId}` : peerId;

    let tile = document.getElementById(`tile-${tileId}`);
    if (!tile) {
      addVideoTile(tileId, name, null, false, isScreen);
      tile = document.getElementById(`tile-${tileId}`);
    }

    if (tile) {
      const video = tile.querySelector('video');
      if (video && video.srcObject !== stream) {
        video.srcObject = stream;
        video.play().catch(() => { });
      }
    }

    if (!isScreen) {
      updateTileBadges(peerId, media.micOn, media.cameraOn);
    }
    updateGridClass();
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
  delete state.peerScreenStreams[peerId];
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
// Smooth, low-latency screen sharing:
// - High framerate constraints (30fps target)
// - RTP encoding priority set to 'high'
// - onnegotiationneeded handles renegotiation automatically
//   for both initiator and non-initiator sides
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
        // Higher framerate = smoother screen share
        frameRate: { ideal: 30, max: 60 },
        width: { ideal: 1920, max: 2560 },
        height: { ideal: 1080, max: 1440 },
        cursor: 'always',
        // Prefer motion clarity over still-frame sharpness (reduces jank)
        displaySurface: 'monitor',
      },
      audio: false,
    });

    state.screenStream = screenStream;
    state.isSharing = true;

    const screenTrack = screenStream.getVideoTracks()[0];

    // Show local screen tile
    addVideoTile('screen-local', `${state.userName}'s Screen`, screenStream, true, true);

    // Tell ALL remote peers the stream ID so ontrack can identify it
    socket.emit('screen-share-started', { streamId: screenStream.id });

    // Add screen track to every peer connection.
    // onnegotiationneeded fires automatically on both sides (fixed),
    // so no manual renegotiation call needed.
    for (const [peerId, pc] of Object.entries(state.peers)) {
      try {
        const sender = pc.addTrack(screenTrack, screenStream);

        // FIX: set high RTP priority so screen share isn't throttled
        // behind camera/audio tracks — reduces jank and delay
        const params = sender.getParameters();
        if (params.encodings && params.encodings.length > 0) {
          params.encodings.forEach(enc => {
            enc.priority = 'high';
            enc.networkPriority = 'high';
            // Remove any artificially low bitrate cap
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

  // Remove screen tracks from all peer connections
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
  if (stream) {
    video.srcObject = stream;
    video.play().catch(() => { });
  }

  grid.appendChild(tile);
  updateGridClass();

  if (isLocal && !isScreen) {
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
    } else if (window.screen.lockOrientation) {
      window.screen.lockOrientation('landscape');
    } else if (window.screen.mozLockOrientation) {
      window.screen.mozLockOrientation('landscape');
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