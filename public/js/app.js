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
  selectedSpeakerId: null,
  audioDevices: [],
  outputDevices: [],
  peers: {},
  peerNames: {},
  peerMedia: {},
  peerScreenInfo: {},
  pendingStreams: {},
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
// MEDIA ACCESS — with proper error handling
// ══════════════════════════════════════════

/**
 * Request camera + mic with graceful fallback:
 * 1. Try video + audio
 * 2. If denied/unavailable, try audio only
 * 3. If audio fails too, return null stream and flag both off
 */
async function requestMediaStream(videoEnabled = true, audioEnabled = true, micDeviceId = null) {
  const audioConstraint = micDeviceId
    ? { deviceId: { exact: micDeviceId }, echoCancellation: true, noiseSuppression: true }
    : { echoCancellation: true, noiseSuppression: true };

  // First attempt: what the user wants
  if (videoEnabled && audioEnabled) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video: true, audio: audioConstraint });
    } catch (e) {
      console.warn('Video+Audio failed:', e.name, e.message);
    }
  }

  // Try video only
  if (videoEnabled && !audioEnabled) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      state.micOn = false;
      return s;
    } catch (e) {
      console.warn('Video only failed:', e.name);
    }
  }

  // Try audio only (camera unavailable/denied)
  if (audioEnabled) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: false, audio: audioConstraint });
      state.cameraOn = false;
      showToast('Camera unavailable — audio only');
      return s;
    } catch (e) {
      console.warn('Audio only failed:', e.name, e.message);
      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        showPermissionError();
      } else if (e.name === 'NotFoundError') {
        showToast('No camera or microphone found');
      } else {
        showToast('Media access failed: ' + e.message);
      }
    }
  }

  state.cameraOn = false;
  state.micOn = false;
  return null;
}

function showPermissionError() {
  const isChrome = /Chrome/.test(navigator.userAgent) && /Google Inc/.test(navigator.vendor);
  const isFirefox = navigator.userAgent.includes('Firefox');
  let msg = 'Camera/mic permission denied.';
  if (isChrome) msg += ' Click the 🔒 icon in the address bar → Allow camera and microphone.';
  else if (isFirefox) msg += ' Click the camera icon in the address bar to grant permission.';
  else msg += ' Please allow camera and microphone access in your browser settings.';
  showModal('Permission Required', msg);
}

function showModal(title, message) {
  // Remove any existing modal
  const existing = document.getElementById('perm-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'perm-modal';
  modal.style.cssText = `
    position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,0.7);backdrop-filter:blur(8px);
  `;
  modal.innerHTML = `
    <div style="background:#111418;border:1px solid rgba(255,255,255,0.12);border-radius:16px;
      padding:32px;max-width:400px;width:90%;text-align:center;box-shadow:0 24px 64px rgba(0,0,0,0.6)">
      <div style="font-size:40px;margin-bottom:12px">🎥</div>
      <h3 style="font-family:'Syne',sans-serif;font-size:20px;color:#e8edf5;margin-bottom:12px">${title}</h3>
      <p style="color:#9ca3af;font-size:14px;line-height:1.6;margin-bottom:24px">${message}</p>
      <button onclick="document.getElementById('perm-modal').remove()" style="
        padding:12px 28px;background:#00e5c0;border:none;border-radius:8px;
        color:#0a0c0f;font-weight:600;font-size:14px;cursor:pointer;font-family:'DM Sans',sans-serif
      ">Got it</button>
    </div>
  `;
  document.body.appendChild(modal);
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

  const stream = await requestMediaStream(state.cameraOn, state.micOn, micDeviceId);
  state.localStream = stream;

  if (stream) {
    $('preview-video').srcObject = stream;
    stream.getAudioTracks().forEach(t => t.enabled = state.micOn);
    stream.getVideoTracks().forEach(t => t.enabled = state.cameraOn);
  }
  updatePrejoinUI();
}

async function populateMicDevices(selectId) {
  try {
    // Must request permission first so labels are populated
    const devices = await navigator.mediaDevices.enumerateDevices();
    state.audioDevices = devices.filter(d => d.kind === 'audioinput');
    state.outputDevices = devices.filter(d => d.kind === 'audiooutput');

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
    if (!state.selectedMicId && state.audioDevices.length > 0) {
      state.selectedMicId = state.audioDevices[0].deviceId;
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
    state.localStream = await requestMediaStream(state.cameraOn, state.micOn, state.selectedMicId);
  }

  // If stream has no video tracks, camera is definitively off
  if (!state.localStream || state.localStream.getVideoTracks().length === 0) {
    state.cameraOn = false;
  }
  // If stream has no audio tracks, mic is definitively off
  if (!state.localStream || state.localStream.getAudioTracks().length === 0) {
    state.micOn = false;
  }

  showScreen('conference');
  $('conf-room-id').textContent = state.roomId;
  addVideoTile('local', state.userName, state.localStream, true);
  updateGridClass();

  // Sync control bar and tile badges to actual state immediately
  updateControlBar();
  updateTileBadges('local', state.micOn, state.cameraOn);
  const localTile = $('tile-local');
  if (localTile) updateLocalTileAvatar(localTile, state.cameraOn);

  state.startTime = Date.now();
  state.timerInterval = setInterval(updateTimer, 1000);

  // Re-enumerate devices now that we have permission (labels should be populated)
  await refreshAllDevices();

  socket.emit('join-room', {
    roomId: state.roomId,
    userName: state.userName,
    micOn: state.micOn,
    cameraOn: state.cameraOn,
  });
}

// ══════════════════════════════════════════
// DEVICE MANAGEMENT (used during call)
// ══════════════════════════════════════════

async function refreshAllDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    state.audioDevices = devices.filter(d => d.kind === 'audioinput');
    state.outputDevices = devices.filter(d => d.kind === 'audiooutput');

    // Auto-select first if none selected yet
    if (!state.selectedMicId && state.audioDevices.length > 0) {
      state.selectedMicId = state.audioDevices[0].deviceId;
    }
    if (!state.selectedSpeakerId && state.outputDevices.length > 0) {
      state.selectedSpeakerId = state.outputDevices[0].deviceId;
    }
  } catch (e) {
    console.warn('Could not enumerate devices:', e);
  }
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
  if (state.ignoreOffer[fromId]) return;

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

socket.on('peer-screen-share', ({ peerId, streamId, sharing }) => {
  if (sharing) {
    state.peerScreenInfo[peerId] = { streamId, stream: null };
    const buffered = state.pendingStreams[peerId]?.[streamId];
    if (buffered) {
      state.peerScreenInfo[peerId].stream = buffered;
      ensureScreenTile(peerId, buffered);
    }
  } else {
    delete state.peerScreenInfo[peerId];
    if (state.pendingStreams[peerId]) {
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
function ensureScreenTile(peerId, stream) {
  const tileId = `screen-${peerId}`;
  let tile = $(`tile-${tileId}`);

  if (!tile) {
    const name = state.peerNames[peerId] || 'Peer';
    addVideoTile(tileId, name, stream, false, true);
    tile = $(`tile-${tileId}`);
  }

  if (tile) {
    const video = tile.querySelector('video');
    if (video && video.srcObject !== stream) {
      video.srcObject = stream;
      video.play().catch(() => { });
    }
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
    state.localStream.getTracks().forEach(track => pc.addTrack(track, state.localStream));
  }

  if (state.screenStream) {
    state.screenStream.getTracks().forEach(track => pc.addTrack(track, state.screenStream));
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
      socket.emit('offer', { targetId: peerId, offer, isPolite: !isInitiator });
    } catch (e) {
      console.error('onnegotiationneeded error:', e);
    } finally {
      state.makingOffer[peerId] = false;
    }
  };

  pc.ontrack = ({ streams }) => {
    const stream = streams[0];
    if (!stream) return;

    if (!state.pendingStreams[peerId]) state.pendingStreams[peerId] = {};
    state.pendingStreams[peerId][stream.id] = stream;

    const info = state.peerScreenInfo[peerId];
    if (info && info.streamId === stream.id) {
      info.stream = stream;
      ensureScreenTile(peerId, stream);
      return;
    }

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

        // Apply speaker if set
        if (state.selectedSpeakerId && video.setSinkId) {
          video.setSinkId(state.selectedSpeakerId).catch(() => { });
        }
      }
      updateTileBadges(peerId, media.micOn, media.cameraOn);
      updateGridClass();
      return;
    }
  };

  pc.onconnectionstatechange = () => {
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
      video: { frameRate: { ideal: 30, max: 60 }, cursor: 'always' },
      audio: false,
    });

    state.screenStream = screenStream;
    state.isSharing = true;

    const screenTrack = screenStream.getVideoTracks()[0];
    addVideoTile('screen-local', `${state.userName}'s Screen`, screenStream, true, true);
    socket.emit('screen-share-started', { streamId: screenStream.id });

    for (const [peerId, pc] of Object.entries(state.peers)) {
      try {
        pc.addTrack(screenTrack, screenStream);
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
    if (avatar) avatar.style.display = 'none';
  }

  // Apply selected speaker to remote video elements
  if (!isLocal && state.selectedSpeakerId && video.setSinkId) {
    video.setSinkId(state.selectedSpeakerId).catch(() => { });
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
    if (requestFn) await requestFn.call(tile, { navigationUI: 'hide' });
  } catch (e) {
    tile.classList.add('fullscreen-css');
  }
}

function handleFullscreenChange() {
  const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
  if (!isFullscreen && currentFullscreen) {
    const tile = $(`tile-${currentFullscreen}`);
    if (tile) { tile.classList.remove('fullscreen-css'); setFullscreenIcon(tile, false); }
    currentFullscreen = null;
  }
}
document.addEventListener('fullscreenchange', handleFullscreenChange);
document.addEventListener('webkitfullscreenchange', handleFullscreenChange);

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
// DEVICE PICKER POPUP (Mic + Speaker tabs)
// ══════════════════════════════════════════

let devicePickerTab = 'mic'; // 'mic' | 'speaker'

$('btn-mic-picker').addEventListener('click', async (e) => {
  e.stopPropagation();
  const picker = $('device-picker');
  const isOpen = !picker.classList.contains('hidden');
  if (isOpen) {
    closeDevicePicker();
    return;
  }
  devicePickerTab = 'mic';
  await openDevicePicker();
});

function closeDevicePicker() {
  $('device-picker').classList.add('hidden');
  $('btn-mic-picker').classList.remove('open');
}

async function openDevicePicker() {
  await refreshAllDevices();
  renderDevicePicker();

  const picker = $('device-picker');
  picker.classList.remove('hidden');

  // Position above the chevron button using fixed coords (picker is not inside ctrl-bar)
  requestAnimationFrame(() => {
    const btn = $('btn-mic-picker');
    const btnRect = btn.getBoundingClientRect();
    const pickerRect = picker.getBoundingClientRect();
    const gap = 10;
    let left = btnRect.left + btnRect.width / 2 - pickerRect.width / 2;
    let top = btnRect.top - pickerRect.height - gap;
    // Clamp to viewport
    left = Math.max(8, Math.min(left, window.innerWidth - pickerRect.width - 8));
    top = Math.max(8, top);
    picker.style.left = left + 'px';
    picker.style.top = top + 'px';
  });

  $('btn-mic-picker').classList.add('open');
}



document.addEventListener('click', (e) => {
  const picker = $('device-picker');
  const btn = $('btn-mic-picker');
  if (picker && !picker.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
    closeDevicePicker();
  }
});

function renderDevicePicker() {
  const picker = $('device-picker');
  const hasSpeaker = state.outputDevices.length > 0 && 'setSinkId' in HTMLMediaElement.prototype;

  picker.innerHTML = `
    <div class="dp-tabs">
      <button class="dp-tab ${devicePickerTab === 'mic' ? 'active' : ''}" data-tab="mic">
        <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 1a4 4 0 0 1 4 4v7a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
        Microphone
      </button>
      ${hasSpeaker ? `
      <button class="dp-tab ${devicePickerTab === 'speaker' ? 'active' : ''}" data-tab="speaker">
        <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
        </svg>
        Speaker
      </button>` : ''}
    </div>
    <ul class="dp-list" id="dp-device-list"></ul>
  `;

  // Tab switching
  picker.querySelectorAll('.dp-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      devicePickerTab = tab.dataset.tab;
      picker.querySelectorAll('.dp-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderDeviceList();
    });
  });

  renderDeviceList();
}

function renderDeviceList() {
  const list = $('dp-device-list');
  if (!list) return;
  list.innerHTML = '';

  const devices = devicePickerTab === 'mic' ? state.audioDevices : state.outputDevices;
  const selectedId = devicePickerTab === 'mic' ? state.selectedMicId : state.selectedSpeakerId;

  if (devices.length === 0) {
    list.innerHTML = `<li class="dp-item" style="color:var(--muted);cursor:default">No devices found</li>`;
    return;
  }

  devices.forEach((device, i) => {
    const li = document.createElement('li');
    const isSelected = device.deviceId === selectedId;
    li.className = 'dp-item' + (isSelected ? ' selected' : '');
    const label = device.label || `${devicePickerTab === 'mic' ? 'Microphone' : 'Speaker'} ${i + 1}`;

    li.innerHTML = `
      <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        ${devicePickerTab === 'mic'
        ? `<path d="M12 1a4 4 0 0 1 4 4v7a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4z"/>
             <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
             <line x1="12" y1="19" x2="12" y2="23"/>
             <line x1="8" y1="23" x2="16" y2="23"/>`
        : `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
             <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>`
      }
      </svg>
      <span class="dp-name" title="${label}">${label}</span>
      <div class="dp-check">${isSelected ? `<svg viewBox="0 0 24 24" width="10" height="10" stroke="currentColor" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>` : ''}</div>
    `;

    li.addEventListener('click', () => {
      if (devicePickerTab === 'mic') selectMicDevice(device.deviceId);
      else selectSpeakerDevice(device.deviceId);
    });

    list.appendChild(li);
  });
}

async function selectMicDevice(deviceId) {
  if (deviceId === state.selectedMicId) { closeDevicePicker(); return; }
  state.selectedMicId = deviceId;
  showToast('Switching microphone…');

  try {
    const newAudioStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true },
      video: false,
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
    showToast('Failed to switch mic: ' + e.message);
  }

  await refreshAllDevices();
  closeDevicePicker();
}

async function selectSpeakerDevice(deviceId) {
  state.selectedSpeakerId = deviceId;
  const deviceName = state.outputDevices.find(d => d.deviceId === deviceId)?.label || 'Speaker';

  // Apply to all remote video elements
  const videos = document.querySelectorAll('#video-grid .video-tile:not(.local) video');
  let applied = 0;
  for (const video of videos) {
    if (video.setSinkId) {
      try { await video.setSinkId(deviceId); applied++; } catch (e) { }
    }
  }

  showToast(`Speaker: ${deviceName.slice(0, 30)}`);
  await refreshAllDevices();
  closeDevicePicker();
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