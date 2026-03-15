/**
 * watch.js — Watch Together sync
 *
 * Three modes:
 * 1. YouTube sync  — host pastes URL, Socket.IO syncs play/pause/seek
 * 2. Local file    — host uploads video, server streams it, all clients stay in sync
 * 3. Screen share  — handled by VoiceRoom (screen share producer in mediasoup)
 *
 * One watch session per text channel. Only host/admin can control playback.
 */

// channelId -> { type, url, fileId, state, hostUsername, viewers }
const watchSessions = new Map();

function createSession(channelId, { type, url, fileId, hostUsername }) {
  const session = {
    type,           // 'youtube' | 'file'
    url: url || null,
    fileId: fileId || null,
    hostUsername,
    state: {
      playing: false,
      currentTime: 0,
      updatedAt: Date.now(),
    },
    viewers: new Set([hostUsername]),
  };
  watchSessions.set(channelId, session);
  return serializeSession(session);
}

function getSession(channelId) {
  const s = watchSessions.get(channelId);
  return s ? serializeSession(s) : null;
}

function endSession(channelId) {
  watchSessions.delete(channelId);
}

function updateState(channelId, { playing, currentTime, username }) {
  const session = watchSessions.get(channelId);
  if (!session) return null;
  if (session.hostUsername !== username) return { ok: false, error: 'Only the host can control playback' };

  session.state.playing = playing;
  session.state.currentTime = currentTime;
  session.state.updatedAt = Date.now();
  return { ok: true, state: session.state };
}

function addViewer(channelId, username) {
  const session = watchSessions.get(channelId);
  if (!session) return null;
  session.viewers.add(username);
  return serializeSession(session);
}

function removeViewer(channelId, username) {
  const session = watchSessions.get(channelId);
  if (!session) return;
  session.viewers.delete(username);
  // If host left, end the session
  if (username === session.hostUsername) watchSessions.delete(channelId);
}

function serializeSession(session) {
  return {
    type: session.type,
    url: session.url,
    fileId: session.fileId,
    hostUsername: session.hostUsername,
    state: { ...session.state },
    viewerCount: session.viewers.size,
  };
}

// Extract YouTube video ID from various URL formats
function extractYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com')) return u.searchParams.get('v');
    if (u.hostname === 'youtu.be') return u.pathname.slice(1);
  } catch (_) {}
  return null;
}

function getAllSessions() {
  const result = {};
  for (const [channelId, session] of watchSessions) {
    result[channelId] = serializeSession(session);
  }
  return result;
}

module.exports = {
  createSession, getSession, endSession,
  updateState, addViewer, removeViewer,
  extractYouTubeId, getAllSessions,
};