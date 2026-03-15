import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { createTunnelSocket } from './tunnel-client';
import ChatWindow from './components/ChatWindow';
import Sidebar from './components/Sidebar';
import LoginForm from './components/LoginForm';
import VoiceCall from './components/VoiceCall';
import GroupCall from './components/GroupCall';
import './App.css';

function App() {
  const [socket, setSocket] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [serverIP, setServerIP] = useState('localhost:3000');
  const [serverName, setServerName] = useState('Concord');
  const [users, setUsers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  // Text channels
  const [textChannels, setTextChannels] = useState([{ id: 'general', name: 'general', type: 'text' }]);
  const [activeChannelId, setActiveChannelId] = useState('general');

  // Voice channels
  const [voiceChannels, setVoiceChannels] = useState([
    { id: 'call-1', name: 'General Voice', members: [] },
  ]);
  const [activeGroupChannel, setActiveGroupChannel] = useState(null);

  // 1-to-1 call
  const [isInCall, setIsInCall] = useState(false);
  const [incomingCall, setIncomingCall] = useState(null);
  const [callWith, setCallWith] = useState(null);
  const [isCallInitiator, setIsCallInitiator] = useState(false);

  const isInCallRef = useRef(false);
  const pendingSignalsRef = useRef([]);
  const voiceCallSignalHandlerRef = useRef(null);
  const groupCallSignalHandlerRef = useRef(null);

  useEffect(() => { isInCallRef.current = isInCall; }, [isInCall]);

  const handleConnect = (username, ip, password, serverName = null) => {
    if (!username.trim()) { setError('Please enter a username'); return; }
    setIsLoading(true);
    setError(null);

    // Detect tunnel (relay URL) vs direct IP
    // Relay: https://something.railway.app  or  any https:// domain
    // Direct: 192.168.x.x:3000  or  localhost:3000
    console.log('🔌 Connecting:', { username, ip, serverName });
    const looksLikeRelay = ip.startsWith('https://') ||
      (!ip.match(/^[\d.]+:/) && !ip.startsWith('localhost') && !ip.startsWith('127.') && ip.includes('.'));

    let sock;
    if (looksLikeRelay) {
  const relayUrl = ip.startsWith('http') ? ip : `https://${ip}`;
  sock = createTunnelSocket(relayUrl, serverName || ip, password || '');
} else {
      // DIRECT / LAN MODE — connect straight to the host IP
      const url = ip.includes('http') ? ip : `http://${ip}`;
      sock = io(url, {
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: 5,
        transports: ['websocket', 'polling'],
      });
    }

    // Read invite token from URL if present (?invite=TOKEN)
    const urlParams = new URLSearchParams(window.location.search);
    const inviteToken = urlParams.get('invite') || undefined;

    sock.on('connect', () => {
      sock.emit('auth:join', {
        username: username.trim(),
        password: password || '',
        avatar: '👤',
        inviteToken,
      });
    });

    sock.on('auth:success', (data) => {
      console.log('✅ auth:success received:', data);
      setCurrentUser({
        username: data.user.username,
        role: data.user.role,
        avatar: data.user.avatar,
        userId: data.user.userId,
      });
      setServerName(data.server?.name || 'Concord');
      setTextChannels(data.textChannels || [{ id: 'general', name: 'general', type: 'text' }]);
      setVoiceChannels(data.voiceChannels || [{ id: 'call-1', name: 'General Voice', members: [] }]);
      setIsConnected(true);
      setServerIP(ip);
      setIsLoading(false);
    });

    sock.on('auth:error', (data) => {
      console.log('❌ auth:error received:', data);
      setError(data.message || 'Authentication failed');
      setIsLoading(false);
      sock.disconnect();
    });

    // Users
    sock.on('users:list', (data) => setUsers(data.users || []));
    sock.on('user:joined', (data) => {
      setUsers(prev => prev.some(u => u.userId === data.userId) ? prev :
        [...prev, { userId: data.userId, username: data.username, role: data.role, ping: 0, avatar: data.avatar || '👤' }]);
    });
    sock.on('user:left', (data) => setUsers(prev => prev.filter(u => u.userId !== data.userId)));
    sock.on('user:roleUpdated', (data) => {
      setUsers(prev => prev.map(u => u.username === data.username ? { ...u, role: data.role } : u));
    });

    // Messages
    sock.on('message:received', (msg) => setMessages(prev => [...prev, msg]));
    sock.on('messages:history', (data) => setMessages(data.messages || []));
    sock.on('message:deleted', (data) => setMessages(prev => prev.filter(m => m.id !== data.messageId)));

    // Ping
    sock.on('ping:request', (data) => sock.emit('ping:response', { timestamp: data.timestamp }));
    sock.on('ping:updated', (data) => {
      setUsers(prev => prev.map(u => u.userId === data.userId ? { ...u, ping: data.ping } : u));
    });

    // Text channel events
    sock.on('channel:created', (ch) => setTextChannels(prev => [...prev, ch]));
    sock.on('channel:deleted', (data) => {
      setTextChannels(prev => prev.filter(ch => ch.id !== data.channelId));
      setActiveChannelId(prev => prev === data.channelId ? 'general' : prev);
    });
    sock.on('channel:renamed', (data) => {
      setTextChannels(prev => prev.map(ch => ch.id === data.id ? { ...ch, name: data.name } : ch));
    });

    // Voice channel events
    sock.on('voice:channels', (data) => setVoiceChannels(data.channels || []));
    sock.on('voice:channelCreated', (vc) => setVoiceChannels(prev => [...prev, vc]));
    sock.on('voice:joined', (data) => {
      setVoiceChannels(prev => prev.map(ch =>
        ch.id === data.channelId
          ? { ...ch, members: [...new Set([...(ch.members || []), data.username])] }
          : ch
      ));
    });
    sock.on('voice:left', (data) => {
      setVoiceChannels(prev => prev.map(ch =>
        ch.id === data.channelId
          ? { ...ch, members: (ch.members || []).filter(m => m !== data.username) }
          : ch
      ));
    });

    // Legacy P2P group-call events (fallback)
    sock.on('group-call:channels', (data) => setVoiceChannels(data.channels || []));
    sock.on('group-call:joined', (data) => {
      setVoiceChannels(prev => prev.map(ch =>
        ch.id === data.channelId
          ? { ...ch, members: [...new Set([...(ch.members || []), data.username])] }
          : ch
      ));
    });
    sock.on('group-call:left', (data) => {
      setVoiceChannels(prev => prev.map(ch =>
        ch.id === data.channelId
          ? { ...ch, members: (ch.members || []).filter(m => m !== data.username) }
          : ch
      ));
    });

    // 1-to-1 call
    sock.on('call:incoming', (data) => {
      if (!isInCallRef.current) {
        setIncomingCall(data.from);
        setIsCallInitiator(false);
      } else {
        sock.emit('call:reject', { to: data.from });
      }
    });

    const routeSignal = (signal) => {
      if (voiceCallSignalHandlerRef.current) {
        voiceCallSignalHandlerRef.current(signal);
      } else if (groupCallSignalHandlerRef.current) {
        groupCallSignalHandlerRef.current(signal);
      } else {
        pendingSignalsRef.current.push(signal);
      }
    };

    sock.on('call:offer',  (data) => routeSignal({ signal: data.offer, from: data.from }));
    sock.on('call:answer', (data) => routeSignal({ signal: data.answer, from: data.from }));
    sock.on('call:ice-candidate', (data) => {
      if (data.candidate) routeSignal({ signal: { type: 'ice-candidate', candidate: data.candidate }, from: data.from });
    });

    sock.on('call:accepted', () => setIsInCall(true));
    sock.on('call:rejected', (data) => {
      alert(`${data.from} rejected your call`);
      setIsInCall(false); setCallWith(null); setIsCallInitiator(false);
    });
    sock.on('call:ended', () => {
      setIsInCall(false); setCallWith(null); setIsCallInitiator(false);
      voiceCallSignalHandlerRef.current = null; pendingSignalsRef.current = [];
    });

    // Admin / server events
    sock.on('kicked', (data) => {
      alert(data.reason || 'You were kicked from the server');
      sock.disconnect();
      setIsConnected(false); setCurrentUser(null); setUsers([]); setMessages([]);
    });
    sock.on('server:updated', (data) => { if (data.name) setServerName(data.name); });
    sock.on('error', (err) => { setError(err.message || 'Error'); });
    sock.on('disconnect', () => { setIsConnected(false); setIsLoading(false); });
    sock.on('connect_error', () => { setError(`Cannot connect to ${ip}`); setIsLoading(false); });

    setSocket(sock);
  };

  // Switch text channel
  const handleSwitchChannel = (channelId) => {
    setActiveChannelId(channelId);
    setMessages([]);
    if (socket) socket.emit('channel:history', { channelId });
  };

  // Send message to active channel
  const handleSendMessage = (text) => {
    if (socket && isConnected) {
      socket.emit('message:send', { text, channelId: activeChannelId });
    }
  };

  // Create text channel
  const handleCreateTextChannel = (name) => {
    if (name?.trim() && socket) socket.emit('channel:create', { name: name.trim() });
  };

  // Create voice channel
  const handleCreateVoiceChannel = (name) => {
    if (name?.trim() && socket) socket.emit('voice:channel:create', { name: name.trim() });
  };

  // 1-to-1 calls
  const handleInitiateCall = (toUsername) => {
    pendingSignalsRef.current = []; voiceCallSignalHandlerRef.current = null;
    setCallWith(toUsername); setIsCallInitiator(true);
    socket.emit('call:initiate', { to: toUsername, from: currentUser.username });
  };

  const handleAcceptCall = (fromUsername) => {
    pendingSignalsRef.current = []; voiceCallSignalHandlerRef.current = null;
    setCallWith(fromUsername); setIsCallInitiator(false);
    setIsInCall(true); setIncomingCall(null);
    socket.emit('call:accepted', { to: fromUsername, from: currentUser.username });
  };

  const handleCallEnd = useCallback(() => {
    setIsInCall(false); setCallWith(null); setIncomingCall(null); setIsCallInitiator(false);
    voiceCallSignalHandlerRef.current = null; pendingSignalsRef.current = [];
  }, []);

  const registerVoiceCallSignalHandler = useCallback((handler) => {
    voiceCallSignalHandlerRef.current = handler;
    const queued = [...pendingSignalsRef.current]; pendingSignalsRef.current = [];
    queued.forEach(s => handler(s));
  }, []);

  // Group call
  const handleJoinGroupChannel = (channel) => {
    if (activeGroupChannel?.id === channel.id) return;
    pendingSignalsRef.current = [];
    groupCallSignalHandlerRef.current = null;
    setActiveGroupChannel(channel);
  };

  const handleLeaveGroupCall = () => {
    setActiveGroupChannel(null);
    groupCallSignalHandlerRef.current = null;
  };

  const registerGroupCallSignalHandler = useCallback((handler) => {
    groupCallSignalHandlerRef.current = handler;
    const queued = [...pendingSignalsRef.current]; pendingSignalsRef.current = [];
    queued.forEach(s => handler(s));
  }, []);

  const handleDisconnect = () => {
    if (socket) {
      socket.disconnect();
      setIsConnected(false); setCurrentUser(null); setUsers([]); setMessages([]);
    }
  };

  useEffect(() => () => { if (socket) socket.disconnect(); }, [socket]);

  if (!isConnected) {
    return <LoginForm onConnect={handleConnect} isLoading={isLoading} error={error} />;
  }

  return (
    <div className="app">
      {/* Top bar */}
      <div className="topbar">
        <button className="topbar-disconnect" onClick={handleDisconnect}>✕ Leave</button>
        <span className="topbar-name">{serverName}</span>
        <span className="topbar-sep">·</span>
        <span className="topbar-ip">{serverIP}</span>
        <div className="topbar-status">
          <div className="topbar-status-dot" />
          LIVE
        </div>
      </div>

      {/* Sidebar */}
      <Sidebar
        users={users}
        currentUser={currentUser}
        voiceChannels={voiceChannels}
        textChannels={textChannels}
        activeChannelId={activeChannelId}
        onSwitchChannel={handleSwitchChannel}
        onJoinChannel={handleJoinGroupChannel}
        onCreateTextChannel={handleCreateTextChannel}
        onCreateVoiceChannel={handleCreateVoiceChannel}
        onInitiateCall={handleInitiateCall}
        activeVoiceChannel={activeGroupChannel?.id}
      />

      {/* Chat */}
      <ChatWindow
        messages={messages}
        currentUser={currentUser}
        onSendMessage={handleSendMessage}
        isConnected={isConnected}
        inCall={!!activeGroupChannel}
        channelName={textChannels.find(c => c.id === activeChannelId)?.name || 'general'}
      />

      {/* 1-to-1: ringing */}
      {!isInCall && callWith && isCallInitiator && (
        <div className="calling-overlay">
          <div className="calling-box">
            <div className="calling-ring">📞</div>
            <div className="calling-name">{callWith}</div>
            <div className="calling-status">ringing...</div>
            <button className="calling-cancel" onClick={() => {
              socket.emit('call:end', { to: callWith }); handleCallEnd();
            }}>Cancel</button>
          </div>
        </div>
      )}

      {/* 1-to-1: active call */}
      {isInCall && callWith && (
        <VoiceCall
          socket={socket}
          currentUser={currentUser}
          onCallEnd={handleCallEnd}
          toUsername={callWith}
          remoteUsername={callWith}
          isInitiator={isCallInitiator}
          onRegisterSignalHandler={registerVoiceCallSignalHandler}
        />
      )}

      {/* Group call */}
      {activeGroupChannel && (
        <GroupCall
          socket={socket}
          currentUser={currentUser}
          channel={activeGroupChannel}
          onLeave={handleLeaveGroupCall}
          onRegisterSignalHandler={registerGroupCallSignalHandler}
        />
      )}

      {/* Incoming 1-to-1 call */}
      {incomingCall && (
        <div className="incoming-call-bar">
          <div className="incoming-call-info">
            <div className="incoming-call-from">{incomingCall}</div>
            <div className="incoming-call-label">incoming call</div>
          </div>
          <div className="incoming-call-actions">
            <button className="icall-btn icall-accept" onClick={() => handleAcceptCall(incomingCall)}>Accept</button>
            <button className="icall-btn icall-reject" onClick={() => { socket.emit('call:end', { to: incomingCall }); setIncomingCall(null); }}>Decline</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;