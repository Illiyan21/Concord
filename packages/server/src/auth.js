const crypto = require('crypto');
const { loadConfig, saveConfig } = require('./config');

// In-memory stores
const inviteTokens = new Map();   // token -> { createdAt, expiresAt, uses }
const bannedUsers  = new Set();   // usernames
const userRoles    = new Map();   // username -> 'host' | 'admin' | 'moderator' | 'member'
const sessions     = new Map();   // sessionToken -> { username, role, socketId }

// The host is whoever starts the server — first connection OR matching localhost
let hostUsername = null;

// ── Session tokens (simple random hex, no JWT dependency) ──
function generateToken(len = 32) {
  return crypto.randomBytes(len).toString('hex');
}

// ── Invite links ──
function createInviteLink(baseUrl) {
  const cfg = loadConfig();
  if (!cfg.invite.enabled) return null;
  const token = generateToken(16);
  const expiresAt = Date.now() + cfg.invite.linkExpiryHours * 60 * 60 * 1000;
  inviteTokens.set(token, { createdAt: Date.now(), expiresAt });
  return { token, url: `${baseUrl}/invite/${token}`, expiresAt };
}

function validateInviteToken(token) {
  const invite = inviteTokens.get(token);
  if (!invite) return false;
  if (Date.now() > invite.expiresAt) { inviteTokens.delete(token); return false; }
  return true;
}

// ── Password check ──
function checkPassword(password) {
  const cfg = loadConfig();
  if (!cfg.server.password) return true; // no password set
  return password === cfg.server.password;
}

// ── Role management ──
function assignRole(username, isFirstUser) {
  if (isFirstUser || hostUsername === null) {
    hostUsername = username;
    userRoles.set(username, 'host');
    console.log(`👑 ${username} is the host`);
    return 'host';
  }
  if (!userRoles.has(username)) {
    userRoles.set(username, 'member');
  }
  return userRoles.get(username);
}

function getRole(username) {
  return userRoles.get(username) || 'member';
}

function setRole(targetUsername, newRole, requestingUsername) {
  const requesterRole = getRole(requestingUsername);
  if (requesterRole !== 'host' && requesterRole !== 'admin') return { ok: false, error: 'Insufficient permissions' };
  if (newRole === 'host') return { ok: false, error: 'Cannot assign host role' };
  if (targetUsername === hostUsername) return { ok: false, error: 'Cannot change host role' };
  userRoles.set(targetUsername, newRole);
  return { ok: true };
}

// ── Ban management ──
function banUser(targetUsername, requestingUsername) {
  const requesterRole = getRole(requestingUsername);
  if (requesterRole !== 'host' && requesterRole !== 'admin') return { ok: false, error: 'Insufficient permissions' };
  if (targetUsername === hostUsername) return { ok: false, error: 'Cannot ban host' };
  bannedUsers.add(targetUsername);
  userRoles.delete(targetUsername);
  return { ok: true };
}

function isBanned(username) {
  return bannedUsers.has(username);
}

function unbanUser(targetUsername, requestingUsername) {
  const requesterRole = getRole(requestingUsername);
  if (requesterRole !== 'host' && requesterRole !== 'admin') return { ok: false, error: 'Insufficient permissions' };
  bannedUsers.delete(targetUsername);
  return { ok: true };
}

function getBannedUsers() {
  return Array.from(bannedUsers);
}

// ── Permission checks ──
function canKick(requestingUsername) {
  const role = getRole(requestingUsername);
  return ['host', 'admin', 'moderator'].includes(role);
}

function canManageChannels(requestingUsername) {
  const role = getRole(requestingUsername);
  return ['host', 'admin'].includes(role);
}

function canManageServer(requestingUsername) {
  return getRole(requestingUsername) === 'host';
}

function canDeleteMessages(requestingUsername) {
  const role = getRole(requestingUsername);
  return ['host', 'admin', 'moderator'].includes(role);
}

// ── Session management ──
function createSession(username, socketId) {
  const token = generateToken();
  sessions.set(token, { username, socketId, createdAt: Date.now() });
  return token;
}

function getSession(token) {
  return sessions.get(token) || null;
}

function removeSession(token) {
  sessions.delete(token);
}

function removeSessionBySocket(socketId) {
  for (const [token, session] of sessions) {
    if (session.socketId === socketId) { sessions.delete(token); break; }
  }
}

module.exports = {
  createInviteLink, validateInviteToken,
  checkPassword,
  assignRole, getRole, setRole,
  banUser, isBanned, unbanUser, getBannedUsers,
  canKick, canManageChannels, canManageServer, canDeleteMessages,
  createSession, getSession, removeSession, removeSessionBySocket,
  generateToken,
};