/**
 * tunnel-client.js
 * ══════════════════════════════════════════════════════════════
 *
 * Drop-in replacement for socket.io-client's io() on the
 * guest browser side.
 *
 * Normal flow:
 *   const sock = io('http://192.168.1.5:3000')
 *   sock.on('auth:success', ...)
 *   sock.emit('auth:join', ...)
 *
 * Tunnel flow (this file):
 *   const sock = createTunnelSocket(relayUrl, serverName, password)
 *   sock.on('auth:success', ...)   ← identical API
 *   sock.emit('auth:join', ...)    ← identical API
 *
 * Internally, the socket connects to the relay and sends all
 * events wrapped in tunnel:toHost. The relay forwards them
 * to the host's server.js. Replies come back via tunnel:toGuest
 * events on the relay, which this class unwraps and delivers
 * as if they came from a normal socket.
 *
 * App.jsx only needs a small change in handleConnect():
 *   - detect if the address is a relay URL
 *   - call createTunnelSocket instead of io()
 */

import { io as socketIo } from 'socket.io-client';

/**
 * Creates a tunnelled socket that mimics the socket.io-client API.
 *
 * @param {string} relayUrl    - e.g. 'https://concord-relay.railway.app'
 * @param {string} serverName  - the Concord server name to join
 * @param {string} password    - server password (empty string if none)
 * @returns {TunnelClientSocket}
 */
export function createTunnelSocket(relayUrl, serverName, password = '') {
  return new TunnelClientSocket(relayUrl, serverName, password);
}

class TunnelClientSocket extends EventTarget {
  constructor(relayUrl, serverName, password) {
    super();
    this._handlers   = {};  // event → [fn, ...]
    this._relayUrl   = relayUrl;
    this._serverName = serverName;
    this._password   = password;
    this.connected   = false;
    this.id          = null;

    this._connect();
  }

  _connect() {
    this._relay = socketIo(this._relayUrl, {
      reconnection:    true,
      reconnectionDelay: 2000,
      transports:      ['websocket', 'polling'],
    });

    this._relay.on('connect', () => {
      console.log(`[TunnelClient] Connected to relay, joining "${this._serverName}"`);
      this._relay.emit('tunnel:guestJoin', {
        serverName: this._serverName,
        password:   this._password,
      });
    });

    this._relay.on('tunnel:joined', (data) => {
      console.log(`[TunnelClient] Joined server "${data.name}" as guest ${data.guestId}`);
      this.id        = data.guestId;
      this.connected = true;
      this._fire('connect');
    });

    this._relay.on('tunnel:joinError', (data) => {
      console.error(`[TunnelClient] Join error: ${data.message}`);
      this._fire('connect_error', new Error(data.message));
    });

    // All events from the host arrive here
    // The relay puts them in tunnel:fromHost but since we're a guest,
    // the relay calls socket.emit(event, data) directly on our relay socket.
    // We intercept ALL socket events that aren't tunnel: prefixed.
    this._relay.onAny((event, data) => {
      // Filter out relay-internal events
      if (event.startsWith('tunnel:') || event.startsWith('relay:')) return;
      // Cache user info so relay ping can report it correctly
      if (event === 'auth:success' && data?.user) {
        this._userId   = data.user.userId;
        this._username = data.user.username;
      }
      // Deliver to handlers registered via .on()
      this._fire(event, data);
    });

    // Relay-level ping — measures client↔relay latency only
    // This replaces the server-measured ping which goes through 4 hops
    this._relay.on('relay:pong', (data) => {
      const ping = Date.now() - data.t;
      this._fire('ping:updated', {
        userId:   this._userId,
        username: this._username,
        ping,
      });
    });

    setInterval(() => {
      if (this._relay.connected && this._userId) {
        this._relay.emit('relay:ping', { t: Date.now() });
      }
    }, 5000);

    this._relay.on('tunnel:serverDown', (data) => {
      console.warn('[TunnelClient] Server went down:', data.message);
      this.connected = false;
      this._fire('disconnect');
    });

    // Don't immediately fire disconnect on relay drop — relay reconnects automatically.
    // Only fire disconnect if we can't reconnect within 15 seconds.
    let _disconnectTimer = null;
    this._relay.on('disconnect', () => {
      this.connected = false;
      console.warn('[TunnelClient] Relay disconnected — waiting for reconnect...');
      _disconnectTimer = setTimeout(() => {
        console.warn('[TunnelClient] Could not reconnect — logging out');
        this._fire('disconnect');
      }, 15000);
    });

    this._relay.on('connect', () => {
      if (_disconnectTimer) {
        clearTimeout(_disconnectTimer);
        _disconnectTimer = null;
        console.log('[TunnelClient] Relay reconnected — re-joining server');
      }
    });

    this._relay.on('connect_error', (err) => {
      this._fire('connect_error', err);
    });
  }

  /** Register an event handler — same as sock.on(event, fn) */
  on(event, fn) {
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(fn);
    return this;
  }

  /** Remove event handler */
  off(event, fn) {
    if (!this._handlers[event]) return this;
    this._handlers[event] = this._handlers[event].filter(h => h !== fn);
    return this;
  }

  /** Register a one-time handler — same as sock.once(event, fn) */
  once(event, fn) {
    const wrapper = (data) => {
      fn(data);
      this.off(event, wrapper);
    };
    return this.on(event, wrapper);
  }

  /** Emit an event to the host server — same as sock.emit(event, data) */
  emit(event, data) {
    if (!this.connected && event !== 'connect') {
      console.warn(`[TunnelClient] emit('${event}') before connected`);
    }
    this._relay.emit('tunnel:toHost', { event, data });
    return this;
  }

  /** Disconnect from relay */
  disconnect() {
    this.connected = false;
    this._relay.disconnect();
    return this;
  }

  /** Internal: fire registered handlers for an event */
  _fire(event, data) {
    const handlers = this._handlers[event] || [];
    handlers.forEach(fn => {
      try { fn(data); } catch (e) { console.error(`[TunnelClient] handler error for '${event}':`, e); }
    });
  }
}