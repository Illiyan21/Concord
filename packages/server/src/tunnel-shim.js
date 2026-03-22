/**
 * tunnel-shim.js
 * ══════════════════════════════════════════════════════════════════
 *
 * This shim makes the host's server.js believe it's talking to
 * normal Socket.IO sockets, while actually everything flows
 * through the relay tunnel.
 *
 * HOW IT WORKS:
 *
 *  Normal Socket.IO:
 *    io.on('connection', socket => { ... })
 *    socket.emit('event', data)       — sends to that client
 *    io.emit('event', data)           — broadcasts to all clients
 *    socket.broadcast.emit(...)       — sends to all except sender
 *
 *  With this shim, ALL of those calls work identically.
 *  Internally they go through the relay instead of direct TCP.
 *
 *  The shim creates:
 *    - TunnelSocket: a fake Socket.IO socket for each guest.
 *      Has .emit(), .on(), .id, .disconnect() — all work normally.
 *    - TunnelIO: a fake io object.
 *      Has .emit() (broadcasts), .on('connection', ...), .to()
 *
 *  server.js uses these exactly like it uses real socket.io,
 *  so zero changes needed in the business logic.
 *
 * ══════════════════════════════════════════════════════════════════
 */

const { io: relayConnect } = require('socket.io-client');
const EventEmitter         = require('events');

// Sanitize data before sending through relay to prevent circular
// reference crashes in socket.io-parser's hasBinary check
function sanitize(data) {
  const seen = new WeakSet();
  try {
    return JSON.parse(JSON.stringify(data, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return undefined;
        seen.add(value);
      }
      return value;
    }));
  } catch (e) {
    console.error('sanitize failed:', e.message);
    return {};
  }
}

class TunnelSocket extends EventEmitter {
  /**
   * Represents one guest connection, as seen from server.js.
   * @param {string}      guestId      - relay-assigned guest socket ID
   * @param {object}      relaySocket  - our connection to the relay
   * @param {TunnelIO}    tunnelIO     - the parent TunnelIO (for broadcasts)
   */
  constructor(guestId, relaySocket, tunnelIO) {
    super();
    this.id            = guestId;
    this._relay        = relaySocket;
    this._io           = tunnelIO;
    this.connected     = true;
    this.data          = {}; // mimic socket.data

    // broadcast.emit — send to all guests except this one
    this.broadcast = {
      emit: (event, data) => {
        this._relay.emit('tunnel:broadcast', {
          event,
          data: sanitize(data),
          excludeGuestId: this.id,
        });
      },
    };

    // rooms mimic (socket.to(room).emit — not used in server.js but just in case)
    this._rooms = new Set([this.id]);
  }

  /** Send event to this specific guest */
  emit(event, data) {
    this._relay.emit('tunnel:toGuest', {
      guestId: this.id,
      event,
      data: sanitize(data),
    });
    return this;
  }

  /** server.js calls socket.to(socketId).emit(event, data) */
  to(targetId) {
    return {
      emit: (event, data) => {
        this._relay.emit('tunnel:toGuest', {
          guestId: targetId,
          event,
          data: sanitize(data),
        });
      }
    };
  }

  /** Called by server.js when it wants to kick/disconnect a guest */
  disconnect(force) {
    this.connected = false;
    if (force) {
      // Hard disconnect (kick/ban) — tell relay to drop the guest's socket
      this._relay.emit('tunnel:disconnectGuest', { guestId: this.id });
    }
    this._io._removeSocket(this.id);
    this.emit_local('disconnect');
  }

  /** Internal: fire local event handlers (not relayed) */
  emit_local(event, ...args) {
    super.emit(event, ...args);
  }

  /** Deliver an incoming message from the relay to server.js's handlers */
  deliver(event, data) {
    super.emit(event, data);
  }
}

class TunnelIO extends EventEmitter {
  /**
   * Drop-in replacement for the socket.io Server (io) object.
   * server.js does:
   *   io.on('connection', socket => { ... })
   *   io.emit('event', data)                — broadcast to all
   *   io.to(socketId).emit('event', data)   — target one socket
   *   io.sockets.sockets.get(id)            — look up a socket
   */
  constructor(relaySocket) {
    super();
    this._relay   = relaySocket;
    this._sockets = new Map(); // guestId → TunnelSocket

    // Mimic io.sockets.sockets
    this.sockets = { sockets: this._sockets };

    // Proxy relay tunnel events into fake socket events
    relaySocket.on('tunnel:guestConnected', ({ guestId }) => {
      const sock = new TunnelSocket(guestId, relaySocket, this);
      this._sockets.set(guestId, sock);
      console.log(`🔌 [Tunnel] Guest connected: ${guestId}`);
      // Use super.emit so it fires local handlers, NOT the broadcast override
      super.emit('connection', sock);
    });

    relaySocket.on('tunnel:guestDisconnected', ({ guestId }) => {
      const sock = this._sockets.get(guestId);
      if (sock) {
        console.log(`❌ [Tunnel] Guest disconnected: ${guestId}`);
        sock.connected = false;
        sock.deliver('disconnect');
        this._sockets.delete(guestId);
      }
    });

    relaySocket.on('tunnel:fromGuest', ({ guestId, event, data }) => {
      const sock = this._sockets.get(guestId);
      if (sock) sock.deliver(event, data);
    });

    relaySocket.on('tunnel:serverDown', () => {
      console.error('❌ [Tunnel] Relay reports server down — this should not happen on the host side');
    });
  }

  /** Broadcast to ALL connected guests */
  emit(event, data) {
    this._relay.emit('tunnel:broadcast', { event, data: sanitize(data), excludeGuestId: null });
    return this;
  }

  /** Target a specific socket by ID — mimic io.to(id) */
  to(socketId) {
    return {
      emit: (event, data) => {
        this._relay.emit('tunnel:toGuest', { guestId: socketId, event, data: sanitize(data) });
      }
    };
  }

  /** server.js calls io.close() on shutdown */
  close(cb) {
    this._relay.disconnect();
    if (cb) cb();
  }

  _removeSocket(id) {
    this._sockets.delete(id);
  }
}

/**
 * createTunnelIO(relayUrl, serverConfig)
 *
 * Call this instead of socketIo(server, options).
 * Returns { io: TunnelIO, startTunnel: async fn }
 *
 * Usage in server.js:
 *   const { createTunnelIO } = require('./tunnel-shim');
 *   const { io, startTunnel } = createTunnelIO(cfg.server.cloudRelayUrl, cfg.server);
 *   // ... set up all your io.on('connection', ...) handlers ...
 *   server.listen(PORT, async () => {
 *     await startTunnel();
 *   });
 */
function createTunnelIO(relayUrl, serverConfig) {
  // Create persistent outbound connection to relay
  const relaySocket = relayConnect(relayUrl, {
    reconnection:        true,
    reconnectionDelay:   3000,
    reconnectionDelayMax: 10000,
    maxHttpBufferSize:   510 * 1024 * 1024,
    transports:          ['websocket'],
  });

  const tunnelIO = new TunnelIO(relaySocket);

  const startTunnel = async () => {
    return new Promise((resolve) => {
      relaySocket.on('connect', () => {
        console.log(`🛰️  Tunnel connected to relay: ${relayUrl}`);

        relaySocket.emit('tunnel:hostRegister', {
          name:       serverConfig.name,
          password:   serverConfig.password || '',
          maxPlayers: serverConfig.maxPlayers || 50,
          region:     serverConfig.region    || 'Unknown',
        });
      });

      relaySocket.on('tunnel:registered', (data) => {
        console.log(`✅ Tunnel registered as "${data.name}"`);
        console.log(`   Share: ${relayUrl}/?join=${encodeURIComponent(data.name)}`);
        resolve(data);
      });

      relaySocket.on('tunnel:error', (d) => {
        console.error(`❌ Tunnel error: ${d.message}`);
        resolve(null); // don't block startup
      });

      relaySocket.on('disconnect', () => {
        console.warn('⚠️  Tunnel disconnected — reconnecting...');
      });

      relaySocket.on('connect_error', (err) => {
        console.warn(`⚠️  Relay unreachable: ${err.message} — will retry`);
        resolve(null);
      });

      // Heartbeat
      setInterval(() => {
        if (relaySocket.connected) {
          relaySocket.emit('tunnel:heartbeat', {
            playerCount: tunnelIO._sockets.size,
          });
        }
      }, 20000);
    });
  };

  return { io: tunnelIO, relaySocket, startTunnel };
}

module.exports = { createTunnelIO, TunnelIO, TunnelSocket };