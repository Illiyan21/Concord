import { useState, useRef, useEffect } from 'react';

function GroupCall({ socket, currentUser, channel, onLeave, onRegisterSignalHandler }) {
  const [isMuted, setIsMuted] = useState(false);
  const [duration, setDuration] = useState(0);
  const [participants, setParticipants] = useState([currentUser.username]);

  const streamRef = useRef(null);
  const peersRef = useRef({});
  const timerRef = useRef(null);
  const pendingOffersRef = useRef([]); // offers that arrived before mic was ready
  const hasJoinedRef = useRef(false);  // true after our first participants update (prevents glare)

  const getInitials = (n) => n ? n.slice(0, 2).toUpperCase() : '??';
  const formatTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  useEffect(() => {
    let alive = true;

    // ── Create a peer connection and add local tracks ──
    // Only call this AFTER streamRef.current is set
    const createPC = (remoteUsername) => {
      console.log(`🔌 Creating PC for ${remoteUsername}, stream ready: ${!!streamRef.current}`);
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      });

      // Add ALL local tracks — stream must exist at this point
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => {
          console.log(`➕ Adding local track: ${track.kind}`);
          pc.addTrack(track, streamRef.current);
        });
      } else {
        console.error('❌ createPC called before stream was ready!');
      }

      pc.ontrack = (e) => {
        console.log(`🔊 Received remote track from ${remoteUsername}: ${e.track.kind}`);
        const audio = new Audio();
        audio.srcObject = e.streams[0];
        audio.autoplay = true;
        audio.play().catch(err => console.warn('Audio play error:', err));
      };

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit('call:ice-candidate', { to: remoteUsername, candidate: e.candidate });
        }
      };

      pc.oniceconnectionstatechange = () => {
        console.log(`🧊 [${remoteUsername}] ICE: ${pc.iceConnectionState}`);
      };

      pc.onconnectionstatechange = () => {
        console.log(`🔗 [${remoteUsername}] Connection: ${pc.connectionState}`);
      };

      return pc;
    };

    // ── Send offer to a remote user (we are initiator) ──
    const sendOffer = async (remoteUsername) => {
      if (peersRef.current[remoteUsername]) return;
      if (remoteUsername === currentUser.username) return;
      console.log(`📤 Initiating offer to ${remoteUsername}`);
      const pc = createPC(remoteUsername);
      peersRef.current[remoteUsername] = pc;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('call:offer', { to: remoteUsername, offer: pc.localDescription });
      } catch (e) {
        console.error('sendOffer error:', e);
      }
    };

    // ── Handle an incoming offer (we are responder) ──
    // MUST only be called after mic is ready
    const handleOffer = async (from, signal) => {
      console.log(`📥 Handling offer from ${from}`);
      if (peersRef.current[from]) {
        peersRef.current[from].close();
        delete peersRef.current[from];
      }
      const pc = createPC(from);
      peersRef.current[from] = pc;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        console.log(`📡 Sending answer → ${from}`);
        socket.emit('call:answer', { to: from, answer: pc.localDescription });
      } catch (e) {
        console.error('handleOffer error:', e);
      }
    };

    // ── Register App-level signal handler immediately (sync) ──
    // Offers received before mic is ready get queued in pendingOffersRef
    onRegisterSignalHandler(async ({ from, signal }) => {
      if (!alive) return;
      console.log(`📨 Signal from ${from}: ${signal?.type || 'ice-candidate'}`);

      if (signal.type === 'offer') {
        if (!streamRef.current) {
          // Mic not ready yet — queue the offer, process after getUserMedia
          console.log(`⏳ Mic not ready, queuing offer from ${from}`);
          pendingOffersRef.current.push({ from, signal });
        } else {
          await handleOffer(from, signal);
        }

      } else if (signal.type === 'answer') {
        const pc = peersRef.current[from];
        if (pc) {
          try { await pc.setRemoteDescription(new RTCSessionDescription(signal)); }
          catch (e) { console.warn('setRemoteDescription error:', e.message); }
        }

      } else if (signal.type === 'ice-candidate' && signal.candidate) {
        const pc = peersRef.current[from];
        if (pc) {
          try { await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)); }
          catch (e) { console.warn('addIceCandidate error:', e.message); }
        }
      }
    });

    // ── Listen for others joining/leaving ──
    const onJoined = (data) => {
      if (data.channelId !== channel.id) return;
      if (data.username === currentUser.username) return;
      console.log(`👤 ${data.username} joined channel — waiting for their offer`);
      // Just update the UI — the newcomer will send US an offer (they initiate to existing members)
      // This prevents WebRTC glare (both sides sending offers simultaneously)
      setParticipants(prev => prev.includes(data.username) ? prev : [...prev, data.username]);
    };

    const onLeft = (data) => {
      if (data.channelId !== channel.id) return;
      console.log(`👤 ${data.username} left channel`);
      setParticipants(prev => prev.filter(p => p !== data.username));
      if (peersRef.current[data.username]) {
        peersRef.current[data.username].close();
        delete peersRef.current[data.username];
      }
    };

    socket.on('group-call:joined', onJoined);
    socket.on('group-call:left', onLeft);

    // ── Participant list handler — defined in outer scope so cleanup can reference it ──
    const onParticipants = async (data) => {
      if (!alive) return;
      if (data.channelId !== channel.id) return;
      const incoming = data.participants || [];
      console.log(`👥 Participants update: [${incoming.join(', ')}]`);
      setParticipants(incoming);

      if (!hasJoinedRef.current) {
        // First update = we just joined. Send offers to everyone already there.
        hasJoinedRef.current = true;
        const others = incoming.filter(u => u !== currentUser.username);
        console.log(`📤 We are the newcomer — offering to: [${others.join(', ') || 'nobody'}]`);
        for (const username of others) {
          await sendOffer(username);
        }
      }
      // Subsequent updates: if someone else joined, they offer us. If left, onLeft cleans up.
    };
    socket.on('group-call:participants', onParticipants);

    // ── Get mic FIRST, then join the channel ──
    const init = async () => {
      // Step 1: Get microphone
      let stream;
      try {
        console.log('🎤 Requesting microphone...');
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (!alive) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        console.log('✅ Mic ready — tracks:', stream.getTracks().map(t => t.kind));
      } catch (err) {
        console.error('❌ Mic error:', err.name, err.message);
        if (alive) onLeave();
        return;
      }

      timerRef.current = setInterval(() => setDuration(d => d + 1), 1000);

      // Step 2: Process any offers that arrived while we were getting the mic
      const queued = [...pendingOffersRef.current];
      pendingOffersRef.current = [];
      for (const { from, signal } of queued) {
        console.log(`🔄 Processing queued offer from ${from}`);
        await handleOffer(from, signal);
      }

      // Step 3: Tell server we joined — server broadcasts full participant list to all
      console.log(`🚀 Joining channel: ${channel.id}`);
      socket.emit('group-call:join', {
        channelId: channel.id,
        username: currentUser.username,
      });
    };

    init();

    return () => {
      alive = false;
      socket.off('group-call:joined', onJoined);
      socket.off('group-call:left', onLeft);
      socket.off('group-call:participants', onParticipants);
      // handleLeave may have already cleaned these up — guard against double-close
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      Object.values(peersRef.current).forEach(pc => pc.close());
      peersRef.current = {};
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLeave = () => {
    console.log('[GroupCall] handleLeave called');
    socket.emit('group-call:leave', { channelId: channel.id, username: currentUser.username });
    console.log('[GroupCall] group-call:leave emitted, starting cleanup...');
    // Clean up locally BEFORE calling onLeave so the cleanup in useEffect
    // doesn't double-close or trigger anything on the socket
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    Object.values(peersRef.current).forEach(pc => pc.close());
    peersRef.current = {};
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    console.log('[GroupCall] calling onLeave()...');
    onLeave(); // just hides the UI — does NOT touch the socket
    console.log('[GroupCall] onLeave() returned');
  };

  const handleToggleMute = () => {
    if (streamRef.current) {
      streamRef.current.getAudioTracks().forEach(t => { t.enabled = !t.enabled; });
      setIsMuted(m => !m);
    }
  };

  return (
    <div className="group-call-overlay">
      <div className="group-call-modal">
        {/* Channel info */}
        <div className="group-call-header">
          <div className="group-call-title">🔊 {channel.name}</div>
          <div className="group-call-channel">{formatTime(duration)}</div>
        </div>

        {/* Participant pills */}
        <div className="group-call-participants">
          {participants.map(name => (
            <div key={name} className={`participant-tile ${name === currentUser.username ? 'speaking' : ''}`}>
              <div className="participant-avatar">{getInitials(name)}</div>
              <div className="participant-name">
                {name}{name === currentUser.username && isMuted ? ' 🔇' : ''}
              </div>
            </div>
          ))}
        </div>

        {/* Controls */}
        <div className="group-call-controls">
          <button className={`gcall-btn gcall-btn-mute ${isMuted ? 'muted' : ''}`} onClick={handleToggleMute}>
            {isMuted ? '🔇' : '🎤'}
          </button>
          <button className="gcall-btn gcall-btn-end" onClick={handleLeave}>
            📵 Leave
          </button>
        </div>
      </div>
    </div>
  );
}

export default GroupCall;