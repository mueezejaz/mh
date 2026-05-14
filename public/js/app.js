/* ══════════════════════════════════════════
   NexMeet — WebRTC Conference App
   ══════════════════════════════════════════ */

const socket = io();

// ── State ──────────────────────────────────
const state = {
  roomId: null,
  userName: null,
  localStream: null,    // camera + mic stream
  screenStream: null,   // screen share stream
  isSharing: false,
  micOn: true,
  cameraOn: true,
  selectedMicId: null,  // deviceId of chosen mic
  audioDevices: [],     // list of audioinput devices
  peers: {},            // peerId -> RTCPeerConnection
  peerNames: {},
  peerMedia: {},
  startTime: null,
  timerInterval: null,
};

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
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
    // Reflect current enabled states
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

// ── Enumerate audio input devices ──
async function populateMicDevices(selectId) {
  try {
    // Need permission first (already asked in getUserMedia above)
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

    // Default to first if none selected
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

$('pj-mic-btn').addEventListener('click', () => {
  state.micOn = !state.micOn;
  updatePrejoinUI();
});
$('pj-cam-btn').addEventListener('click', () => {
  state.cameraOn = !state.cameraOn;
  updatePrejoinUI();
});

// Pre-join mic selector change
$('pj-mic-select').addEventListener('change', async (e) => {
  state.selectedMicId = e.target.value;
  await startPreviewStream(state.selectedMicId);
});

$('pj-cancel').addEventListener('click', () => {
  stopLocalStream();
  showScreen('lobby');
});

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
// SIGNALING
// ══════════════════════════════════════════
socket.on('room-peers', async ({ peers }) => {
  for (const peer of peers) {
    state.peerNames[peer.id] = peer.name;
    state.peerMedia[peer.id] = { micOn: peer.micOn, cameraOn: peer.cameraOn };
    await createPeerConnection(peer.id, true);
  }
});

socket.on('peer-joined', async ({ peerId, name, micOn, cameraOn }) => {
  state.peerNames[peerId] = name;
  state.peerMedia[peerId] = { micOn, cameraOn };
  showToast(`${name} joined`);
  await createPeerConnection(peerId, false);
});

socket.on('offer', async ({ fromId, fromName, offer }) => {
  if (!state.peers[fromId]) {
    state.peerNames[fromId] = fromName;
    await createPeerConnection(fromId, false);
  }
  const pc = state.peers[fromId];
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', { targetId: fromId, answer });
});

socket.on('answer', async ({ fromId, answer }) => {
  const pc = state.peers[fromId];
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on('ice-candidate', async ({ fromId, candidate }) => {
  const pc = state.peers[fromId];
  if (pc && candidate) {
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) { }
  }
});

socket.on('peer-media-state', ({ peerId, micOn, cameraOn }) => {
  state.peerMedia[peerId] = { micOn, cameraOn };
  updateTileBadges(peerId, micOn, cameraOn);
});

socket.on('peer-left', ({ peerId }) => {
  showToast(`${state.peerNames[peerId] || 'Someone'} left`);
  removePeer(peerId);
});

// ══════════════════════════════════════════
// RTCPeerConnection
// ══════════════════════════════════════════
async function createPeerConnection(peerId, isInitiator) {
  const pc = new RTCPeerConnection(ICE_CONFIG);
  state.peers[peerId] = pc;

  // Add all local tracks (camera + possibly screen)
  const streams = [state.localStream, state.screenStream].filter(Boolean);
  streams.forEach(stream => {
    stream.getTracks().forEach(track => pc.addTrack(track, stream));
  });

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('ice-candidate', { targetId: peerId, candidate });
  };

  pc.ontrack = ({ streams }) => {
    const stream = streams[0];
    const name = state.peerNames[peerId] || 'Peer';
    const media = state.peerMedia[peerId] || { micOn: true, cameraOn: true };

    let tile = document.getElementById(`tile-${peerId}`);
    if (!tile) {
      addVideoTile(peerId, name, null, false);
      tile = document.getElementById(`tile-${peerId}`);
    }
    const video = tile.querySelector('video');
    if (video) {
      video.srcObject = stream;
      video.play().catch(() => { });
    }
    updateTileBadges(peerId, media.micOn, media.cameraOn);
    updateGridClass();
  };

  pc.onconnectionstatechange = () => {
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) removePeer(peerId);
  };

  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { targetId: peerId, offer });
  }
  return pc;
}

function removePeer(peerId) {
  if (state.peers[peerId]) { state.peers[peerId].close(); delete state.peers[peerId]; }
  delete state.peerNames[peerId];
  delete state.peerMedia[peerId];
  const tile = document.getElementById(`tile-${peerId}`);
  if (tile) tile.remove();
  updateGridClass();
}

// ══════════════════════════════════════════
// VIDEO TILES
// ══════════════════════════════════════════
function addVideoTile(id, name, stream, isLocal, isScreen = false) {
  const grid = $('video-grid');
  const tile = document.createElement('div');
  const cls = ['video-tile'];
  if (isLocal && !isScreen) cls.push('local');
  if (isScreen) cls.push('screen-tile');
  tile.className = cls.join(' ');
  tile.id = `tile-${id}`;

  const initial = name ? name[0].toUpperCase() : '?';

  tile.innerHTML = `
    <video autoplay ${isLocal ? 'muted' : ''} playsinline></video>
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
    if (isLocal && !isScreen) updateLocalTileAvatar(tile, state.cameraOn);
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
  // Preserve screen badge if present
  const screenBadge = badge.querySelector('.screen-badge');
  badge.innerHTML = screenBadge ? '' : '';
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

function toggleTileFullscreen(id) {
  const tile = $(`tile-${id}`);
  if (!tile) return;

  if (currentFullscreen === id) {
    tile.classList.remove('fullscreen');
    currentFullscreen = null;
    setFullscreenIcon(tile, false);
  } else {
    if (currentFullscreen) {
      const prev = $(`tile-${currentFullscreen}`);
      if (prev) { prev.classList.remove('fullscreen'); setFullscreenIcon(prev, false); }
    }
    tile.classList.add('fullscreen');
    currentFullscreen = id;
    setFullscreenIcon(tile, true);
  }
}

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

  // Refresh device list each time
  await refreshMicPickerList();
  picker.classList.remove('hidden');
  chevron.classList.add('open');
});

// Close mic picker when clicking elsewhere
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
    // Just close the picker
    $('mic-picker').classList.add('hidden');
    $('btn-mic-picker').classList.remove('open');
    return;
  }

  state.selectedMicId = deviceId;
  showToast('Switching microphone…');

  try {
    // Get new audio stream with selected device
    const newAudioStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId } },
      video: false,
    });

    const newAudioTrack = newAudioStream.getAudioTracks()[0];
    if (!newAudioTrack) throw new Error('No audio track');

    // Apply enabled state
    newAudioTrack.enabled = state.micOn;

    // Replace the audio track in localStream
    if (state.localStream) {
      const oldTracks = state.localStream.getAudioTracks();
      oldTracks.forEach(t => { state.localStream.removeTrack(t); t.stop(); });
      state.localStream.addTrack(newAudioTrack);
    } else {
      state.localStream = newAudioStream;
    }

    // Replace the sender track in all peer connections
    for (const pc of Object.values(state.peers)) {
      const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
      if (sender) {
        await sender.replaceTrack(newAudioTrack);
      }
    }

    const deviceName = state.audioDevices.find(d => d.deviceId === deviceId)?.label || 'Microphone';
    showToast(`Mic: ${deviceName.slice(0, 30)}`);
  } catch (e) {
    showToast('Failed to switch microphone: ' + e.message);
  }

  // Refresh the picker list to show new selection
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
      video: { cursor: 'always', displaySurface: 'monitor' },
      audio: false,
    });
    state.screenStream = screenStream;
    state.isSharing = true;

    const screenTrack = screenStream.getVideoTracks()[0];

    // Add screen share tile locally
    addVideoTile('screen-local', `${state.userName}'s Screen`, screenStream, true, true);

    // Add the screen track to all existing peer connections
    for (const pc of Object.values(state.peers)) {
      pc.addTrack(screenTrack, screenStream);
      // Renegotiate
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { targetId: Object.keys(state.peers).find(k => state.peers[k] === pc), offer });
    }

    // When user stops from browser UI
    screenTrack.onended = () => stopScreenShare();

    updateShareButton(true);
    showToast('Screen sharing started');
  } catch (e) {
    if (e.name !== 'NotAllowedError') showToast('Screen share failed: ' + e.message);
  }
}

async function stopScreenShare() {
  if (!state.screenStream) return;
  state.screenStream.getTracks().forEach(t => t.stop());
  state.screenStream = null;
  state.isSharing = false;

  // Remove screen tile
  const tile = $('tile-screen-local');
  if (tile) tile.remove();
  updateGridClass();

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