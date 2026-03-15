const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../../config.json');
const DEFAULT_CONFIG = {
  server: { name: 'Concord Server', port: 3000, password: '', mode: 'self-hosted', cloudRelayUrl: '', announceIp: '' },
  media: { maxVideoBitrate: 2500000, maxScreenShareBitrate: 5000000, maxAudioBitrate: 128000, maxFileSizeMB: 500, tempFileExpiryMinutes: 60 },
  invite: { enabled: true, linkExpiryHours: 24 },
  channels: [{ id: 'general', name: 'general', type: 'text' }],
  voiceChannels: [{ id: 'call-1', name: 'General Voice' }]
};

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      console.log('⚠️  config.json not found, using defaults. Creating config.json...');
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
      return DEFAULT_CONFIG;
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    // Deep merge with defaults so missing keys don't crash
    return deepMerge(DEFAULT_CONFIG, cfg);
  } catch (err) {
    console.error('❌ Failed to load config.json:', err.message);
    return DEFAULT_CONFIG;
  }
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function saveConfig(updates) {
  try {
    const current = loadConfig();
    const updated = deepMerge(current, updates);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2));
    return updated;
  } catch (err) {
    console.error('❌ Failed to save config:', err.message);
    return null;
  }
}

module.exports = { loadConfig, saveConfig };