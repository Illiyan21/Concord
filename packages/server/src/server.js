/**
 * Concord Server — v3 (Tunnel Mode)
 *
 * Changes from v2:
 *  1. When cloudRelayUrl is set in config.json, the server
 *     connects OUTBOUND to the relay via tunnel-shim.js.
 *     No inbound connections, no port forwarding needed.
 *
 *  2. When cloudRelayUrl is blank, falls back to direct
 *     Socket.IO on PORT (LAN mode, same as before).
 *
 *  3. WebRTC ICE servers are fetched from the relay so guests
 *     get STUN/TURN config automatically.
 *
 *  Everything else (auth, channels, voice, mediasoup, admin)
 *  is completely unchanged.
 */

const express   = require('express');
const http      = require('http');
const socketIo  = require('socket.io');
const cors      = require('cors');
const { v4: uuidv4 } = require('uuid');
const path      = require('path');
const os        = require('os');
const fs        = require('fs');

const { loadConfig }         = require('./config');
const auth                   = require('./auth');
const channelMgr             = require('./channels');
const sfu                    = require('./mediasoup');
const watchMgr               = require('./watch');
const { setupFileRoutes }    = require('./files');
const { createTunnelIO }     = require('./tunnel-shim');

// ── Boot ──────────────────────────────────────────────────────────
const cfg  = loadConfig();
const PORT = process.env.PORT || cfg.server.port || 3000;

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces))
    for (const iface of ifaces[name])
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
  return 'localhost';
}
const LOCAL_IP    = getLocalIP();
const ANNOUNCE_IP = cfg.server.announceIp || LOCAL_IP;

// ── Express ───────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: `${cfg.media.maxFileSizeMB + 1}mb` }));

// Serve built React frontend
const distPath = path.join(__dirname, '../../web/dist');
if (fs.existsSync(distPath)) app.use(express.static(distPath));

setupFileRoutes(app);

app.get('/invite/:token', (req, res) => {
  const valid = auth.validateInviteToken(req.params.token);
  if (!valid) return res.status(410).send('Invite link expired or invalid.');
  res.redirect(`/?invite=${req.params.token}`);
});

app.get('/api/health', (_, res) => {
  res.json({ status: 'ok', serverName: cfg.server.name, mode: cfg.server.mode,
    sfuAvailable: sfu.isAvailable(), uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString() });
});

app.get('*', (req, res) => {
  const idx = path.join(distPath, 'index.html');
  if (fs.existsSync(idx)) res.sendFile(idx);
  else res.status(404).send('Run: cd packages/web && npm run build');
});

// ── Socket.IO or Tunnel ────────────────────────────────────────────
// If cloudRelayUrl is set → use tunnel (no port forwarding)
// If not set             → use direct socket.io on PORT (LAN mode)
const RELAY_URL   = cfg.server.cloudRelayUrl;
const USE_TUNNEL  = !!RELAY_URL;

let io;
let startTunnel   = null;
let relaySocket   = null;

if (USE_TUNNEL) {
  console.log(`🛰️  Tunnel mode — will connect outbound to ${RELAY_URL}`);
  const tunnel = createTunnelIO(RELAY_URL, cfg.server);
  io           = tunnel.io;
  relaySocket  = tunnel.relaySocket;
  startTunnel  = tunnel.startTunnel;
} else {
  console.log('🏠 LAN mode — direct Socket.IO on port', PORT);
  io = socketIo(server, {
    cors: { origin: '*' },
    pingInterval: 25000,
    pingTimeout: 60000,
    maxHttpBufferSize: (cfg.media.maxFileSizeMB + 1) * 1024 * 1024,
  });
}

// ── Init ──────────────────────────────────────────────────────────
const users = new Map(); // socketId → userData
function getUserByUsername(u) { for (const x of users.values()) if (x.username === u) return x; return null; }
function getPublicUsers()     { return Array.from(users.values()).map(u => ({ userId: u.userId, username: u.username, role: u.role, avatar: u.avatar, ping: u.ping })); }

channelMgr.init();
let sfuReady = false;
sfu.init(ANNOUNCE_IP).then(ok => {
  sfuReady = ok;
  console.log(ok ? '🎙️  SFU ready' : '🎙️  SFU unavailable — P2P fallback');
});

// Ping broadcast — runs in both modes
setInterval(() => io.emit('ping:request', { timestamp: Date.now() }), 5000);

function notifyRelayCount() {
  if (relaySocket?.connected) {
    relaySocket.emit('tunnel:heartbeat', { playerCount: users.size });
  }
}

// ════════════════════════════════════════════════════════════════
// SOCKET.IO CONNECTION HANDLER
// (identical whether using tunnel or direct — shim handles the diff)
// ════════════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  // ── AUTH ──────────────────────────────────────────────────────
  socket.on('auth:join', (data) => {
    const { username, password, inviteToken, avatar } = data;
    if (!username?.trim()) return socket.emit('auth:error', { message: 'Username required' });
    if (auth.isBanned(username)) return socket.emit('auth:error', { message: 'You are banned' });
    const hasValidInvite = inviteToken && auth.validateInviteToken(inviteToken);
    if (!hasValidInvite && !auth.checkPassword(password))
      return socket.emit('auth:error', { message: 'Incorrect password' });

    const isFirst = users.size === 0;
    const role    = auth.assignRole(username.trim(), isFirst);
    const userData = {
      userId: uuidv4(), username: username.trim(), role,
      avatar: avatar || '👤', ping: 0,
      socketId: socket.id, currentChannel: 'general',
    };
    users.set(socket.id, userData);
    notifyRelayCount();
    console.log(`✅ ${username} joined [${role}] (total: ${users.size})`);

    socket.emit('auth:success', {
      user:          { userId: userData.userId, username: userData.username, role, avatar: userData.avatar },
      server:        { name: cfg.server.name, mode: cfg.server.mode, sfuAvailable: sfuReady },
      textChannels:  channelMgr.getTextChannels(),
      voiceChannels: channelMgr.getVoiceChannels(),
      watchSessions: watchMgr.getAllSessions(),
    });
    socket.emit('users:list', { users: getPublicUsers() });
    socket.emit('messages:history', { channelId: 'general', messages: channelMgr.getHistory('general', 100) });
    socket.broadcast.emit('user:joined', { userId: userData.userId, username: userData.username, role, avatar: userData.avatar });
    socket.emit('voice:channels', { channels: channelMgr.getVoiceChannels() });
  });

  // ── DISCONNECT ──────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (!user) return;
    console.log(`❌ ${user.username} disconnected`);
    for (const vc of channelMgr.getVoiceChannels()) {
      if (vc.members.includes(user.username)) {
        channelMgr.leaveVoiceChannel(vc.id, user.username);
        io.emit('voice:left', { channelId: vc.id, username: user.username });
        if (sfuReady) sfu.cleanupUser(vc.id, user.username);
      }
    }
    watchMgr.removeViewer(null, user.username);
    users.delete(socket.id);
    notifyRelayCount();
    io.emit('user:left', { userId: user.userId, username: user.username });
  });

  socket.on('ping:response', (data) => {
    const user = users.get(socket.id); if (!user) return;
    user.ping = Date.now() - data.timestamp;
    io.emit('ping:updated', { userId: user.userId, username: user.username, ping: user.ping });
  });

  // ── TEXT CHANNELS ───────────────────────────────────────────────
  socket.on('message:send', (data) => {
    const u = users.get(socket.id); if (!u) return;
    const msg = channelMgr.addMessage(data.channelId || 'general', { username: u.username, text: data.text, role: u.role, fileAttachment: data.fileAttachment || null });
    if (msg) io.emit('message:received', msg);
  });
  socket.on('message:delete', (data) => {
    const u = users.get(socket.id); if (!u || !auth.canDeleteMessages(u.username)) return socket.emit('error', { message: 'No permission' });
    if (channelMgr.deleteMessage(data.channelId, data.messageId)) io.emit('message:deleted', { channelId: data.channelId, messageId: data.messageId });
  });
  socket.on('channel:history', (data) => socket.emit('messages:history', { channelId: data.channelId, messages: channelMgr.getHistory(data.channelId, 100) }));
  socket.on('channel:create', (data) => { const u = users.get(socket.id); if (!u) return; io.emit('channel:created', channelMgr.createTextChannel(data.name)); });
  socket.on('channel:delete', (data) => { const u = users.get(socket.id); if (!u || !auth.canManageChannels(u.username)) return socket.emit('error', { message: 'No permission' }); const r = channelMgr.deleteTextChannel(data.channelId); if (r.ok) io.emit('channel:deleted', { channelId: data.channelId }); else socket.emit('error', { message: r.error }); });
  socket.on('channel:rename', (data) => { const u = users.get(socket.id); if (!u || !auth.canManageChannels(u.username)) return socket.emit('error', { message: 'No permission' }); const r = channelMgr.renameTextChannel(data.channelId, data.newName); if (r.ok) io.emit('channel:renamed', r.channel); else socket.emit('error', { message: r.error }); });

  // ── VOICE CHANNELS ──────────────────────────────────────────────
  socket.on('voice:join', async (data) => {
    const user = users.get(socket.id); if (!user) return;
    const vc = channelMgr.joinVoiceChannel(data.channelId, user.username);
    if (!vc) return socket.emit('error', { message: 'Voice channel not found' });
    io.emit('voice:joined', { channelId: data.channelId, username: user.username });
    if (sfuReady) {
      try {
        await sfu.getOrCreateRouter(data.channelId);
        socket.emit('sfu:routerCapabilities', { channelId: data.channelId, rtpCapabilities: sfu.getRtpCapabilities(data.channelId), existingProducers: sfu.getProducers(data.channelId, user.username) });
      } catch { socket.emit('voice:fallbackP2P', { channelId: data.channelId }); }
    } else {
      socket.emit('voice:participants', { channelId: data.channelId, participants: vc.members });
      socket.broadcast.emit('voice:userJoined', { channelId: data.channelId, username: user.username });
    }
  });
  socket.on('voice:leave', (data) => { const u = users.get(socket.id); if (!u) return; channelMgr.leaveVoiceChannel(data.channelId, u.username); if (sfuReady) sfu.cleanupUser(data.channelId, u.username); io.emit('voice:left', { channelId: data.channelId, username: u.username }); });
  socket.on('voice:channel:create', (data) => { const u = users.get(socket.id); if (!u) return; io.emit('voice:channelCreated', channelMgr.createVoiceChannel(data.name)); });

  // ── SFU ─────────────────────────────────────────────────────────
  socket.on('sfu:createTransport',  async (data) => { if (!sfuReady) return; const u = users.get(socket.id); if (!u) return; try { socket.emit('sfu:transportCreated', { ...await sfu.createTransport(data.channelId, u.username, data.direction), direction: data.direction }); } catch (e) { socket.emit('error', { message: e.message }); } });
  socket.on('sfu:connectTransport', async (data) => { if (!sfuReady) return; try { await sfu.connectTransport(data.channelId, data.transportId, data.dtlsParameters); socket.emit('sfu:transportConnected', { transportId: data.transportId }); } catch (e) { socket.emit('error', { message: e.message }); } });
  socket.on('sfu:produce',          async (data) => { if (!sfuReady) return; const u = users.get(socket.id); if (!u) return; try { const pid = await sfu.produce(data.channelId, data.transportId, u.username, data.kind, data.rtpParameters, data.label); socket.emit('sfu:produced', { producerId: pid, kind: data.kind, label: data.label }); socket.broadcast.emit('sfu:newProducer', { channelId: data.channelId, producerId: pid, username: u.username, kind: data.kind, label: data.label }); } catch (e) { socket.emit('error', { message: e.message }); } });
  socket.on('sfu:consume',          async (data) => { if (!sfuReady) return; const u = users.get(socket.id); if (!u) return; try { socket.emit('sfu:consumed', await sfu.consume(data.channelId, data.transportId, data.producerId, data.rtpCapabilities)); } catch (e) { socket.emit('error', { message: e.message }); } });
  socket.on('sfu:closeProducer',    async (data) => { if (!sfuReady) return; await sfu.closeProducer(data.channelId, data.producerId); socket.broadcast.emit('sfu:producerClosed', { channelId: data.channelId, producerId: data.producerId }); });

  // ── P2P CALL SIGNALS ────────────────────────────────────────────
  const fwdTo = (ev, outEv) => socket.on(ev, (d) => {
    const t = getUserByUsername(d.to);
    if (t) io.to(t.socketId).emit(outEv || ev, { from: users.get(socket.id)?.username, ...d });
  });
  fwdTo('call:offer'); fwdTo('call:answer'); fwdTo('call:accepted'); fwdTo('call:rejected'); fwdTo('call:end', 'call:ended');
  socket.on('call:ice-candidate', (d) => { const s = users.get(socket.id); const t = getUserByUsername(d.to); if (s && t && d.candidate) io.to(t.socketId).emit('call:ice-candidate', { from: s.username, candidate: d.candidate }); });
  socket.on('call:initiate', (d) => { const t = getUserByUsername(d.to); if (t) io.to(t.socketId).emit('call:incoming', { from: users.get(socket.id)?.username }); });

  // ── GROUP CALL ──────────────────────────────────────────────────
  socket.on('group-call:join', (data) => {
    const user = users.get(socket.id); if (!user) return;
    const vc = channelMgr.getVoiceChannel(data.channelId); if (!vc) return;
    channelMgr.joinVoiceChannel(data.channelId, data.username);
    const allMembers = [...vc.members]; // snapshot AFTER joining
    // Broadcast full participant list to ALL users so no one misses a join
    io.emit('group-call:participants', { channelId: data.channelId, participants: allMembers });
    io.emit('voice:joined',            { channelId: data.channelId, username: data.username });
  });
  socket.on('group-call:leave', (data) => {
    channelMgr.leaveVoiceChannel(data.channelId, data.username);
    const vc = channelMgr.getVoiceChannel(data.channelId);
    const remaining = vc ? [...vc.members] : [];
    // Broadcast full participant list AND left event so everyone stays in sync
    io.emit('group-call:participants', { channelId: data.channelId, participants: remaining });
    io.emit('group-call:left',         { channelId: data.channelId, username: data.username });
    io.emit('voice:left',              { channelId: data.channelId, username: data.username });
  });

  // ── WATCH TOGETHER ──────────────────────────────────────────────
  socket.on('watch:start',   (data) => { const u = users.get(socket.id); if (!u) return; const ytId = data.type === 'youtube' ? watchMgr.extractYouTubeId(data.url) : null; if (data.type === 'youtube' && !ytId) return socket.emit('error', { message: 'Invalid YouTube URL' }); io.emit('watch:started', { channelId: data.channelId, session: watchMgr.createSession(data.channelId, { type: data.type, url: data.type === 'youtube' ? data.url : null, fileId: data.type === 'file' ? data.fileId : null, hostUsername: u.username }) }); });
  socket.on('watch:join',    (data) => { const u = users.get(socket.id); if (!u) return; const s = watchMgr.addViewer(data.channelId, u.username); if (s) socket.emit('watch:state', { channelId: data.channelId, session: s }); });
  socket.on('watch:control', (data) => { const u = users.get(socket.id); if (!u) return; const r = watchMgr.updateState(data.channelId, { playing: data.playing, currentTime: data.currentTime, username: u.username }); if (r?.ok) io.emit('watch:sync', { channelId: data.channelId, state: r.state }); else if (r) socket.emit('error', { message: r.error }); });
  socket.on('watch:end',     (data) => { const u = users.get(socket.id); if (!u) return; const s = watchMgr.getSession(data.channelId); if (s?.hostUsername !== u.username && !auth.canManageChannels(u.username)) return socket.emit('error', { message: 'No permission' }); watchMgr.endSession(data.channelId); io.emit('watch:ended', { channelId: data.channelId }); });

  // ── ADMIN ───────────────────────────────────────────────────────
  socket.on('admin:kick',         (data) => { const u = users.get(socket.id); if (!u || !auth.canKick(u.username)) return socket.emit('error', { message: 'No permission' }); const t = getUserByUsername(data.username); if (!t) return socket.emit('error', { message: 'User not found' }); io.to(t.socketId).emit('kicked', { reason: data.reason || 'Kicked' }); setTimeout(() => { const ts = io.sockets.sockets.get(t.socketId); if (ts) ts.disconnect(true); }, 500); });
  socket.on('admin:ban',          (data) => { const u = users.get(socket.id); if (!u) return; const r = auth.banUser(data.username, u.username); if (!r.ok) return socket.emit('error', { message: r.error }); const t = getUserByUsername(data.username); if (t) { io.to(t.socketId).emit('kicked', { reason: data.reason || 'Banned' }); setTimeout(() => { const ts = io.sockets.sockets.get(t.socketId); if (ts) ts.disconnect(true); }, 500); } socket.emit('admin:banSuccess', { username: data.username }); });
  socket.on('admin:unban',        (data) => { const u = users.get(socket.id); if (!u) return; socket.emit('admin:unbanResult', auth.unbanUser(data.username, u.username)); });
  socket.on('admin:setRole',      (data) => { const u = users.get(socket.id); if (!u) return; const r = auth.setRole(data.username, data.role, u.username); if (!r.ok) return socket.emit('error', { message: r.error }); const t = getUserByUsername(data.username); if (t) { t.role = data.role; io.emit('user:roleUpdated', { username: data.username, role: data.role }); } });
  socket.on('admin:getInfo',      ()     => { const u = users.get(socket.id); if (!u || !auth.canManageServer(u.username)) return socket.emit('error', { message: 'No permission' }); socket.emit('admin:info', { bannedUsers: auth.getBannedUsers(), onlineUsers: getPublicUsers(), serverName: cfg.server.name, mode: cfg.server.mode, uptime: Math.floor(process.uptime()) }); });
  socket.on('admin:createInvite', ()     => { const u = users.get(socket.id); if (!u || !auth.canManageChannels(u.username)) return socket.emit('error', { message: 'No permission' }); const inv = auth.createInviteLink(`http://${ANNOUNCE_IP}:${PORT}`); if (!inv) return socket.emit('error', { message: 'Invites disabled' }); socket.emit('admin:inviteCreated', inv); });
  socket.on('admin:updateServer', (data) => { const u = users.get(socket.id); if (!u || !auth.canManageServer(u.username)) return socket.emit('error', { message: 'No permission' }); const { saveConfig } = require('./config'); if (data.name) saveConfig({ server: { name: data.name } }); io.emit('server:updated', { name: data.name || cfg.server.name }); });
  socket.on('error', (e) => console.error('Socket error:', e));
});

// ── START ─────────────────────────────────────────────────────────
if (USE_TUNNEL) {
  // Tunnel mode: HTTP server only needs to serve the frontend.
  // Socket.IO connections go through the relay, not this port.
  server.listen(PORT, async () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║           🚀 CONCORD SERVER (TUNNEL MODE)        ║
╠══════════════════════════════════════════════════╣
║  Server Name : ${(cfg.server.name).padEnd(32)}║
║  Frontend    : http://localhost:${String(PORT).padEnd(17)}║
║  Relay       : ${RELAY_URL.substring(0, 32).padEnd(32)}║
║  Mode        : Tunnel (no port forwarding!)      ║
╚══════════════════════════════════════════════════╝
    `);
    await startTunnel();
  });
} else {
  // LAN mode: normal Socket.IO on PORT
  server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║           🚀 CONCORD SERVER (LAN MODE)           ║
╠══════════════════════════════════════════════════╣
║  Server Name : ${(cfg.server.name).padEnd(32)}║
║  Local URL   : http://localhost:${String(PORT).padEnd(17)}║
║  Network URL : http://${LOCAL_IP}:${String(PORT).padEnd(5)}           ║
║  Mode        : Direct (LAN only)                 ║
╚══════════════════════════════════════════════════╝
    `);
  });
}

process.on('SIGTERM', () => { if (relaySocket) relaySocket.disconnect(); io.close(); server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { if (relaySocket) relaySocket.disconnect(); io.close(); server.close(() => process.exit(0)); });