const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { loadConfig, saveConfig } = require('./config');

const DATA_DIR  = path.join(__dirname, '../../data');
const MSGS_FILE = path.join(DATA_DIR, 'messages.json');
const MAX_HISTORY = 500; // messages per channel

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// In-memory channels map: channelId -> { id, name, type, messages[] }
const channels = new Map();
// In-memory voice channels: channelId -> { id, name, members[] }
const voiceChannels = new Map();

// ── Load from config + persisted messages ──
function init() {
  const cfg = loadConfig();

  // Load persisted messages
  let savedMessages = {};
  try {
    if (fs.existsSync(MSGS_FILE)) savedMessages = JSON.parse(fs.readFileSync(MSGS_FILE, 'utf8'));
  } catch (e) { console.warn('Could not load message history:', e.message); }

  // Init text channels
  for (const ch of cfg.channels) {
    channels.set(ch.id, {
      id: ch.id,
      name: ch.name,
      type: 'text',
      messages: (savedMessages[ch.id] || []).slice(-MAX_HISTORY)
    });
  }

  // Init voice channels
  for (const vc of cfg.voiceChannels) {
    voiceChannels.set(vc.id, { id: vc.id, name: vc.name, members: [] });
  }

  console.log(`📢 Loaded ${channels.size} text channels, ${voiceChannels.size} voice channels`);
}

// ── Persist messages to disk (debounced) ──
let saveTimer = null;
function persistMessages() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = {};
    for (const [id, ch] of channels) data[id] = ch.messages.slice(-MAX_HISTORY);
    try { fs.writeFileSync(MSGS_FILE, JSON.stringify(data)); }
    catch (e) { console.warn('Could not save messages:', e.message); }
  }, 2000);
}

// ── Text channel CRUD ──
function getTextChannels() {
  return Array.from(channels.values()).map(ch => ({ id: ch.id, name: ch.name, type: ch.type }));
}

function getChannel(channelId) {
  return channels.get(channelId) || null;
}

function createTextChannel(name) {
  const id = `ch-${uuidv4().slice(0, 8)}`;
  const ch = { id, name: name.trim().toLowerCase().replace(/\s+/g, '-'), type: 'text', messages: [] };
  channels.set(id, ch);
  // Persist channel list to config
  saveConfig({ channels: getTextChannels() });
  return ch;
}

function deleteTextChannel(channelId) {
  if (channelId === 'general') return { ok: false, error: 'Cannot delete #general' };
  const deleted = channels.delete(channelId);
  if (deleted) saveConfig({ channels: getTextChannels() });
  return { ok: deleted };
}

function renameTextChannel(channelId, newName) {
  const ch = channels.get(channelId);
  if (!ch) return { ok: false, error: 'Channel not found' };
  ch.name = newName.trim().toLowerCase().replace(/\s+/g, '-');
  saveConfig({ channels: getTextChannels() });
  return { ok: true, channel: { id: ch.id, name: ch.name } };
}

// ── Messages ──
function addMessage(channelId, { username, text, role, fileAttachment }) {
  const ch = channels.get(channelId);
  if (!ch) return null;
  const msg = {
    id: uuidv4(),
    channelId,
    username,
    text: text || '',
    role,
    fileAttachment: fileAttachment || null,
    timestamp: Date.now()
  };
  ch.messages.push(msg);
  if (ch.messages.length > MAX_HISTORY) ch.messages.shift();
  persistMessages();
  return msg;
}

function deleteMessage(channelId, messageId) {
  const ch = channels.get(channelId);
  if (!ch) return false;
  const idx = ch.messages.findIndex(m => m.id === messageId);
  if (idx === -1) return false;
  ch.messages.splice(idx, 1);
  persistMessages();
  return true;
}

function getHistory(channelId, limit = 50) {
  const ch = channels.get(channelId);
  if (!ch) return [];
  return ch.messages.slice(-limit);
}

// ── Voice channel management ──
function getVoiceChannels() {
  return Array.from(voiceChannels.values()).map(vc => ({
    id: vc.id, name: vc.name, members: [...vc.members]
  }));
}

function createVoiceChannel(name) {
  const id = `vc-${uuidv4().slice(0, 8)}`;
  const vc = { id, name: name.trim(), members: [] };
  voiceChannels.set(id, vc);
  saveConfig({ voiceChannels: getVoiceChannels().map(v => ({ id: v.id, name: v.name })) });
  return vc;
}

function deleteVoiceChannel(channelId) {
  const deleted = voiceChannels.delete(channelId);
  if (deleted) saveConfig({ voiceChannels: getVoiceChannels().map(v => ({ id: v.id, name: v.name })) });
  return { ok: deleted };
}

function joinVoiceChannel(channelId, username) {
  // Remove from any other channel first
  for (const vc of voiceChannels.values()) {
    vc.members = vc.members.filter(m => m !== username);
  }
  const vc = voiceChannels.get(channelId);
  if (!vc) return null;
  if (!vc.members.includes(username)) vc.members.push(username);
  return vc;
}

function leaveVoiceChannel(channelId, username) {
  const vc = voiceChannels.get(channelId);
  if (!vc) return null;
  vc.members = vc.members.filter(m => m !== username);
  return vc;
}

function getVoiceChannel(channelId) {
  return voiceChannels.get(channelId) || null;
}

module.exports = {
  init,
  getTextChannels, getChannel, createTextChannel, deleteTextChannel, renameTextChannel,
  addMessage, deleteMessage, getHistory,
  getVoiceChannels, createVoiceChannel, deleteVoiceChannel,
  joinVoiceChannel, leaveVoiceChannel, getVoiceChannel,
};