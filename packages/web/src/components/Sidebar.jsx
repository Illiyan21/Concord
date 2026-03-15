import { useState } from 'react';

function Sidebar({ 
  users = [],
  currentUser,
  voiceChannels = [],
  textChannels = [],
  activeChannelId,
  onSwitchChannel,
  onJoinChannel,
  onCreateVoiceChannel,
  onCreateTextChannel,
  onInitiateCall,
  activeVoiceChannel,
  socket,
}) {
  const [showTextInput, setShowTextInput] = useState(false);
  const [newTextName, setNewTextName] = useState('');
  const [showVoiceInput, setShowVoiceInput] = useState(false);
  const [newVoiceName, setNewVoiceName] = useState('');

  const getPingColor = (ping) => {
    if (!ping || ping <= 0) return 'var(--text-muted)';
    if (ping < 80) return 'var(--green)';
    if (ping < 200) return '#f0b232';
    return '#ed4245';
  };

  const getInitials = (name) => name ? name.slice(0, 2).toUpperCase() : '??';

  const getRoleBadge = (role) => {
    if (role === 'host') return '👑';
    if (role === 'admin') return '⚡';
    if (role === 'moderator') return '🛡️';
    return '';
  };

  const handleCreateText = (e) => {
    e.preventDefault();
    if (newTextName.trim() && onCreateTextChannel) {
      onCreateTextChannel(newTextName.trim());
      setNewTextName('');
      setShowTextInput(false);
    }
  };

  const handleCreateVoice = (e) => {
    e.preventDefault();
    if (newVoiceName.trim() && onCreateVoiceChannel) {
      onCreateVoiceChannel(newVoiceName.trim());
      setNewVoiceName('');
      setShowVoiceInput(false);
    }
  };

  return (
    <div className="sidebar">

      {/* ── Text Channels ── */}
      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <span>Text Channels</span>
          <button
            onClick={() => { setShowTextInput(v => !v); setNewTextName(''); }}
            title="Add text channel"
          >+</button>
        </div>

        {showTextInput && (
          <form onSubmit={handleCreateText} style={{ padding: '4px 8px 6px' }}>
            <input
              autoFocus
              className="login-input"
              style={{ fontSize: '12px', padding: '5px 8px' }}
              placeholder="channel-name"
              value={newTextName}
              onChange={e => setNewTextName(e.target.value.toLowerCase().replace(/\s+/g, '-'))}
              onKeyDown={e => e.key === 'Escape' && setShowTextInput(false)}
            />
          </form>
        )}

        {textChannels.map(ch => (
          <div
            key={ch.id}
            className={`voice-channel ${activeChannelId === ch.id ? 'active' : ''}`}
            onClick={() => onSwitchChannel && onSwitchChannel(ch.id)}
          >
            <span className="voice-channel-icon">#</span>
            <span>{ch.name}</span>
          </div>
        ))}
      </div>

      <div className="sidebar-divider" />

      {/* ── Voice Channels ── */}
      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <span>Voice Channels</span>
          <button
            onClick={() => { setShowVoiceInput(v => !v); setNewVoiceName(''); }}
            title="Add voice channel"
          >+</button>
        </div>

        {showVoiceInput && (
          <form onSubmit={handleCreateVoice} style={{ padding: '4px 8px 6px' }}>
            <input
              autoFocus
              className="login-input"
              style={{ fontSize: '12px', padding: '5px 8px' }}
              placeholder="Voice channel name"
              value={newVoiceName}
              onChange={e => setNewVoiceName(e.target.value)}
              onKeyDown={e => e.key === 'Escape' && setShowVoiceInput(false)}
            />
          </form>
        )}

        {voiceChannels.map(ch => (
          <div key={ch.id}>
            <div
              className={`voice-channel ${activeVoiceChannel === ch.id ? 'active' : ''}`}
              onClick={() => onJoinChannel && onJoinChannel(ch)}
            >
              <span className="voice-channel-icon">🔊</span>
              <span>{ch.name}</span>
              {ch.members?.length > 0 && (
                <span style={{
                  marginLeft: 'auto', fontSize: '10px',
                  color: 'var(--green)', fontFamily: 'var(--font-mono)'
                }}>
                  {ch.members.length}
                </span>
              )}
            </div>
            {ch.members?.length > 0 && (
              <div className="voice-channel-members">
                {ch.members.map(m => (
                  <div key={m} className="voice-member">
                    <div className="voice-member-dot" />
                    {m}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="sidebar-divider" />

      {/* ── Online Users ── */}
      <div className="sidebar-section-header" style={{ paddingTop: '8px' }}>
        <span>Online — {users.length}</span>
      </div>

      <div className="sidebar-users">
        {users.map(user => (
          <div
            key={user.userId}
            className="user-row"
            onClick={() => {
              if (user.username !== currentUser?.username && onInitiateCall) {
                onInitiateCall(user.username);
              }
            }}
            style={{ cursor: user.username !== currentUser?.username ? 'pointer' : 'default' }}
            title={user.username !== currentUser?.username ? `Call ${user.username}` : 'You'}
          >
            <div className={`user-avatar-circle ${user.username === currentUser?.username ? 'me' : ''}`}>
              {getInitials(user.username)}
            </div>
            <div className="user-row-info">
              <div className="user-row-name">
                {getRoleBadge(user.role) && <span style={{ marginRight: '4px' }}>{getRoleBadge(user.role)}</span>}
                {user.username}
              </div>
              {user.ping > 0 && (
                <div className="user-row-ping" style={{ color: getPingColor(user.ping) }}>
                  {user.ping}ms
                </div>
              )}
            </div>
            <div className="online-dot" />
          </div>
        ))}
      </div>

      {/* ── Current user bar ── */}
      {currentUser && (
        <div className="current-user-bar">
          <div className="user-avatar-circle me">{getInitials(currentUser.username)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="current-user-name">{currentUser.username}</div>
            <div className="current-user-label">{currentUser.role || 'member'}</div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Sidebar;