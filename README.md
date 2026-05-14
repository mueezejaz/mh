# NexMeet — WebRTC Video Conference App

A full-featured, peer-to-peer video conference app built with:
- **Node.js + Express** — HTTP server & room REST endpoint
- **Socket.IO** — WebRTC signaling (offer/answer/ICE)
- **WebRTC** — browser-native peer-to-peer video/audio
- **Vanilla HTML/CSS/JS** — no frontend frameworks needed

---

## Features

- 🎥 Multi-participant video + audio (peer-to-peer)
- 🚪 Pre-join lobby — preview camera/mic before entering
- 🔇 Toggle mic on/off during call
- 📷 Toggle camera on/off during call
- ⛶ Per-participant fullscreen button (hover over any tile)
- 🆔 Generate or share room codes (8-char)
- ⏱ Live call duration timer
- 📋 One-click room code copy
- 👤 Avatar fallback when camera is off
- 🔴 Visual badges when mic/camera is off

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start the server
node server.js

# 3. Open your browser
# http://localhost:3000
```

For **LAN testing** (multiple devices on the same network):
```bash
node server.js
# Then open http://<your-local-ip>:3000 on other devices
```

> **Note:** WebRTC requires HTTPS in production. For localhost testing, browsers allow plain HTTP.  
> For public deployment, add SSL (e.g. via nginx + Let's Encrypt or use a service like Heroku/Railway).

---

## File Structure

```
webrtc-conf/
├── server.js              # Express + Socket.IO signaling server
├── package.json
└── public/
    ├── index.html         # Single-page app (lobby + pre-join + conference)
    ├── css/
    │   └── style.css      # All styles
    └── js/
        └── app.js         # WebRTC logic, signaling, UI
```

---

## How It Works

1. **Create/Join Room** → enter your name, get/enter a room code
2. **Pre-join Screen** → preview your camera, toggle mic/cam before joining
3. **Conference** → Socket.IO negotiates WebRTC offers/answers/ICE between all peers
4. **Direct P2P** → after signaling, all audio/video flows directly peer-to-peer

### Signaling Flow
```
Peer A joins            Peer B joins
    │                       │
    ├──join-room──────────► server
    │                       ├──join-room──► server
    │ ◄──room-peers──────── server
    │                       │ ◄──peer-joined── server
    ├──offer──────────────► server ──────────► Peer B
    │ ◄──answer──────────── server ◄──────── Peer B
    ├──ice-candidate──────► server ──────────► Peer B  (both ways)
    │                           (P2P video/audio established)
```

---

## Production Deployment

For public access across different networks, add a TURN server (STUN only works on same NAT):

```javascript
// In server.js or client ICE_CONFIG, add:
{ urls: 'turn:your-turn-server.com', username: 'user', credential: 'pass' }
```

Free TURN services: Twilio Network Traversal, Metered.ca, or self-host with coturn.
