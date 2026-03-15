/**
 * mediasoup.js — SFU room management
 *
 * Each voice/video channel gets its own Router (mediasoup room).
 * Each user in a room gets:
 *   - One WebRtcTransport for sending (producing)
 *   - One WebRtcTransport for receiving (consuming)
 *
 * The server never decodes media — it just forwards RTP packets.
 * CPU usage stays ~1-3% even with 50 users in a room.
 */

let mediasoup;
let worker;
const routers  = new Map(); // channelId -> Router
const rooms    = new Map(); // channelId -> { producers: Map, consumers: Map, transports: Map }

// mediasoup codec config — supports Opus audio, VP8/H264 video
const MEDIA_CODECS = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 1000 },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '4d0032',
      'level-asymmetry-allowed': 1,
    },
  },
];

const TRANSPORT_OPTIONS = {
  listenIps: [
    { ip: '0.0.0.0', announcedIp: null }, // announcedIp set dynamically
  ],
  enableUdp: true,
  enableTcp: true,
  preferUdp: true,
  initialAvailableOutgoingBitrate: 1000000,
};

async function init(announceIp) {
  try {
    mediasoup = require('mediasoup');
  } catch (e) {
    console.warn('⚠️  mediasoup not installed. Voice/video will use P2P fallback.');
    console.warn('   Run: npm install mediasoup --save');
    return false;
  }

  // Update announced IP (needed for clients outside LAN)
  if (announceIp) TRANSPORT_OPTIONS.listenIps[0].announcedIp = announceIp;

  try {
    worker = await mediasoup.createWorker({
      logLevel: 'warn',
      rtcMinPort: 40000,
      rtcMaxPort: 49999,
    });

    worker.on('died', () => {
      console.error('❌ mediasoup worker died, restarting...');
      setTimeout(() => init(announceIp), 2000);
    });

    console.log('✅ mediasoup worker started (PID:', worker.pid, ')');
    return true;
  } catch (err) {
    console.error('❌ Failed to start mediasoup worker:', err.message);
    return false;
  }
}

async function getOrCreateRouter(channelId) {
  if (routers.has(channelId)) return routers.get(channelId);

  const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
  routers.set(channelId, router);
  rooms.set(channelId, {
    producers: new Map(),   // producerId -> { producer, username, kind, label }
    consumers: new Map(),   // consumerId -> consumer
    transports: new Map(),  // transportId -> { transport, username, direction }
    users: new Map(),       // username -> { sendTransportId, recvTransportId, producers: [] }
  });
  console.log(`🏠 Room created: ${channelId}`);
  return router;
}

function getRoom(channelId) {
  return rooms.get(channelId) || null;
}

function getRtpCapabilities(channelId) {
  const router = routers.get(channelId);
  if (!router) return null;
  return router.rtpCapabilities;
}

async function createTransport(channelId, username, direction) {
  const router = routers.get(channelId);
  if (!router) throw new Error('Router not found');

  const transport = await router.createWebRtcTransport(TRANSPORT_OPTIONS);

  transport.on('dtlsstatechange', (state) => {
    if (state === 'closed') transport.close();
  });

  const room = rooms.get(channelId);
  room.transports.set(transport.id, { transport, username, direction });

  return {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
  };
}

async function connectTransport(channelId, transportId, dtlsParameters) {
  const room = rooms.get(channelId);
  if (!room) throw new Error('Room not found');
  const entry = room.transports.get(transportId);
  if (!entry) throw new Error('Transport not found');
  await entry.transport.connect({ dtlsParameters });
}

async function produce(channelId, transportId, username, kind, rtpParameters, label) {
  const room = rooms.get(channelId);
  if (!room) throw new Error('Room not found');
  const entry = room.transports.get(transportId);
  if (!entry) throw new Error('Transport not found');

  const producer = await entry.transport.produce({ kind, rtpParameters });
  room.producers.set(producer.id, { producer, username, kind, label: label || kind });

  // Track which producers belong to this user
  if (!room.users.has(username)) room.users.set(username, { producers: [] });
  room.users.get(username).producers.push(producer.id);

  producer.on('transportclose', () => {
    room.producers.delete(producer.id);
  });

  console.log(`📡 New producer [${kind}/${label}] from ${username} in ${channelId}`);
  return producer.id;
}

async function consume(channelId, transportId, producerId, rtpCapabilities) {
  const room = rooms.get(channelId);
  if (!room) throw new Error('Room not found');
  const router = routers.get(channelId);

  if (!router.canConsume({ producerId, rtpCapabilities })) {
    throw new Error('Cannot consume — incompatible RTP capabilities');
  }

  const entry = room.transports.get(transportId);
  if (!entry) throw new Error('Transport not found');

  const consumer = await entry.transport.consume({
    producerId,
    rtpCapabilities,
    paused: false,
  });

  room.consumers.set(consumer.id, consumer);

  consumer.on('transportclose', () => room.consumers.delete(consumer.id));
  consumer.on('producerclose', () => room.consumers.delete(consumer.id));

  return {
    id: consumer.id,
    producerId,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
  };
}

async function closeProducer(channelId, producerId) {
  const room = rooms.get(channelId);
  if (!room) return;
  const entry = room.producers.get(producerId);
  if (!entry) return;
  entry.producer.close();
  room.producers.delete(producerId);
}

function getProducers(channelId, excludeUsername) {
  const room = rooms.get(channelId);
  if (!room) return [];
  return Array.from(room.producers.entries())
    .filter(([_, p]) => p.username !== excludeUsername)
    .map(([id, p]) => ({ id, username: p.username, kind: p.kind, label: p.label }));
}

function cleanupUser(channelId, username) {
  const room = rooms.get(channelId);
  if (!room) return;

  const userInfo = room.users.get(username);
  if (userInfo) {
    for (const producerId of userInfo.producers) {
      const entry = room.producers.get(producerId);
      if (entry) { entry.producer.close(); room.producers.delete(producerId); }
    }
    room.users.delete(username);
  }

  // Close all transports for this user
  for (const [id, entry] of room.transports) {
    if (entry.username === username) {
      entry.transport.close();
      room.transports.delete(id);
    }
  }

  // If room is empty, clean it up
  if (room.users.size === 0) {
    const router = routers.get(channelId);
    if (router) { router.close(); routers.delete(channelId); }
    rooms.delete(channelId);
    console.log(`🏠 Room closed (empty): ${channelId}`);
  }
}

function isAvailable() {
  return !!worker;
}

module.exports = {
  init, isAvailable,
  getOrCreateRouter, getRoom, getRtpCapabilities,
  createTransport, connectTransport,
  produce, consume, closeProducer,
  getProducers, cleanupUser,
};