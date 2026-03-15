import { useState, useEffect } from 'react';

const RELAY_URL = import.meta.env.VITE_RELAY_URL || '';

function LoginForm({ onConnect, isLoading, error }) {
  const [tab, setTab] = useState('browse');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [serverIP, setServerIP] = useState('localhost:3000');
  const [servers, setServers] = useState([]);
  const [loadingServers, setLoadingServers] = useState(false);
  const [selectedServer, setSelectedServer] = useState(null);
  const [modalPassword, setModalPassword] = useState('');
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    if (tab === 'browse') fetchServers();
  }, [tab]);

  const fetchServers = async () => {
    if (!RELAY_URL) return;
    setLoadingServers(true);
    try {
      const res = await fetch(`${RELAY_URL}/api/servers`);
      const data = await res.json();
      setServers(data.servers || []);
    } catch {
      setServers([]);
    }
    setLoadingServers(false);
  };

  const handleBrowseJoin = (server) => {
    if (!username.trim()) return;
    if (server.hasPassword) {
      setSelectedServer(server);
      setModalPassword('');
      setShowModal(true);
    } else {
      onConnect(username, RELAY_URL, '', server.name);
    }
  };

  const handleModalJoin = () => {
    setShowModal(false);
    onConnect(username, RELAY_URL, modalPassword, selectedServer.name);
  };

  const handleDirectConnect = (e) => {
    e.preventDefault();
    if (username.trim()) onConnect(username, serverIP, password);
  };

  return (
    <div className="login-page">
      <div className="login-card">

        <div className="login-logo">
          <div className="login-logo-text">CONCORD</div>
          <div className="login-logo-sub">P2P COMMUNICATION PLATFORM</div>
        </div>

        {error && <div className="login-error">⚠ {error}</div>}

        {/* Tabs */}
        <div style={{ display: 'flex', gap: '6px', marginBottom: '20px' }}>
          {['browse', 'direct', 'host'].map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                flex: 1,
                padding: '7px',
                borderRadius: '6px',
                border: '1px solid',
                borderColor: tab === t ? 'var(--accent)' : 'var(--border)',
                background: tab === t ? 'var(--accent)' : 'transparent',
                color: tab === t ? 'white' : 'var(--text-muted)',
                fontSize: '11px',
                fontFamily: 'var(--font-mono)',
                fontWeight: 600,
                cursor: 'pointer',
                letterSpacing: '0.5px',
                textTransform: 'uppercase',
              }}
            >
              {t === 'browse' ? '🌐 Browse' : t === 'direct' ? '🔗 Direct' : '🖥 Host'}
            </button>
          ))}
        </div>

        {/* Browse Tab */}
        {tab === 'browse' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div className="login-field">
              <label className="login-label">Username</label>
              <input
                className="login-input"
                type="text"
                placeholder="enter username"
                value={username}
                onChange={e => setUsername(e.target.value)}
                autoFocus
              />
            </div>

            <div style={{ border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
              {loadingServers ? (
                <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', fontFamily: 'var(--font-mono)' }}>
                  Scanning for servers...
                </div>
              ) : servers.length === 0 ? (
                <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                  <div style={{ fontSize: '24px', marginBottom: '8px' }}>🔌</div>
                  No servers online
                </div>
              ) : (
                servers.map((s, i) => (
                  <div key={s.id} style={{
                    display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px',
                    borderBottom: i < servers.length - 1 ? '1px solid var(--border)' : 'none',
                    background: 'var(--bg-mid)',
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        {s.name}
                        {s.hasPassword && <span style={{ fontSize: '10px', background: 'rgba(250,166,26,0.15)', color: '#faa61a', padding: '1px 5px', borderRadius: '4px' }}>🔒</span>}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                        {s.playerCount}/{s.maxPlayers} · {s.region}
                      </div>
                    </div>
                    <button
                      onClick={() => handleBrowseJoin(s)}
                      disabled={!username.trim() || s.playerCount >= s.maxPlayers}
                      style={{
                        padding: '5px 14px', borderRadius: '5px', border: 'none',
                        background: s.playerCount >= s.maxPlayers ? 'var(--bg-light)' : 'var(--accent)',
                        color: s.playerCount >= s.maxPlayers ? 'var(--text-muted)' : 'white',
                        fontSize: '12px', fontWeight: 600, cursor: username.trim() ? 'pointer' : 'not-allowed',
                        opacity: !username.trim() ? 0.5 : 1,
                      }}
                    >
                      {s.playerCount >= s.maxPlayers ? 'Full' : 'Join'}
                    </button>
                  </div>
                ))
              )}
            </div>

            <button
              className="login-btn"
              onClick={fetchServers}
              disabled={loadingServers}
              style={{ background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
            >
              ↻ Refresh
            </button>
          </div>
        )}

        {/* Direct Connect Tab */}
        {tab === 'direct' && (
          <form onSubmit={handleDirectConnect} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div className="login-field">
              <label className="login-label">Server Address</label>
              <input className="login-input" type="text" placeholder="localhost:3000" value={serverIP} onChange={e => setServerIP(e.target.value)} />
            </div>
            <div className="login-field">
              <label className="login-label">Username</label>
              <input className="login-input" type="text" placeholder="enter username" value={username} onChange={e => setUsername(e.target.value)} autoFocus />
            </div>
            <div className="login-field">
              <label className="login-label">Password <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
              <input className="login-input" type="password" placeholder="leave blank if none" value={password} onChange={e => setPassword(e.target.value)} />
            </div>
            <button className="login-btn" type="submit" disabled={isLoading || !username.trim()}>
              {isLoading ? 'CONNECTING...' : 'CONNECT'}
            </button>
            <div className="login-tips">
              <div className="login-tip">localhost:3000 → same machine</div>
              <div className="login-tip">192.168.x.x:3000 → local network</div>
            </div>
          </form>
        )}

        {/* Host Tab */}
        {tab === 'host' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ background: 'var(--bg-mid)', borderRadius: '8px', padding: '14px', fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px' }}>How to host a server</div>
              <div style={{ marginBottom: '6px' }}>1. Install Node.js 18+ on your PC</div>
              <div style={{ marginBottom: '6px' }}>2. Download Concord and run:</div>
              <div style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-dark)', padding: '8px 10px', borderRadius: '5px', fontSize: '12px', marginBottom: '6px' }}>
                npm run server
              </div>
              <div style={{ marginBottom: '6px' }}>3. In <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-dark)', padding: '1px 5px', borderRadius: '3px' }}>packages/config.json</code> set:</div>
              <div style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-dark)', padding: '8px 10px', borderRadius: '5px', fontSize: '11px' }}>
                "cloudRelayUrl": "{RELAY_URL}"
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', background: 'rgba(59,165,93,0.1)', borderRadius: '8px', fontSize: '12px', color: 'var(--green)', fontFamily: 'var(--font-mono)' }}>
              <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--green)', flexShrink: 0 }} />
              Relay online — your server will appear in Browse automatically
            </div>
          </div>
        )}

      </div>

      {/* Password modal */}
      {showModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}>
          <div style={{ background: 'var(--bg-dark)', border: '1px solid var(--border)', borderRadius: '12px', padding: '28px', width: '320px' }}>
            <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '16px', color: 'var(--text-primary)' }}>🔒 Password required</div>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '16px' }}>{selectedServer?.name} is password protected.</div>
            <input
              className="login-input"
              type="password"
              placeholder="Enter server password"
              value={modalPassword}
              onChange={e => setModalPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleModalJoin()}
              autoFocus
              style={{ marginBottom: '14px' }}
            />
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={() => setShowModal(false)} style={{ flex: 1, padding: '9px', borderRadius: '6px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleModalJoin} style={{ flex: 1, padding: '9px', borderRadius: '6px', border: 'none', background: 'var(--accent)', color: 'white', fontWeight: 600, cursor: 'pointer' }}>Join</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default LoginForm;