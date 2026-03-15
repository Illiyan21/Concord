import { useState, useRef, useEffect } from 'react';

function VoiceCall({ socket, currentUser, onCallEnd, remoteUsername, toUsername, isInitiator, onRegisterSignalHandler }) {
  const [isConnected, setIsConnected] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('Starting...');

  const pcRef = useRef(null);
  const streamRef = useRef(null);
  const audioRef = useRef(null);
  const timerRef = useRef(null);
  const pendingOfferRef = useRef(null); // offer that arrived before PC was ready
  const remoteUser = toUsername || remoteUsername;

  useEffect(() => {
    let alive = true;

    // Register signal handler IMMEDIATELY before any async work
    // If offer arrives before PC is ready, queue it
    onRegisterSignalHandler(async ({ from, signal }) => {
      if (!alive) return;

      if (signal.type === 'offer') {
        if (!pcRef.current) {
          // PC not ready yet — store and process after init
          console.log('📥 Offer queued (PC not ready yet)');
          pendingOfferRef.current = signal;
          return;
        }
        await handleOffer(signal);

      } else if (signal.type === 'answer') {
        if (!pcRef.current) return;
        try {
          await pcRef.current.setRemoteDescription(new RTCSessionDescription(signal));
        } catch (e) { console.warn('setRemoteDescription error:', e.message); }

      } else if (signal.type === 'ice-candidate') {
        if (!pcRef.current || !signal.candidate) return;
        try {
          await pcRef.current.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } catch (e) { console.warn('addIceCandidate error:', e.message); }
      }
    });

    const handleOffer = async (signal) => {
      try {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(signal));
        const answer = await pcRef.current.createAnswer();
        await pcRef.current.setLocalDescription(answer);
        socket.emit('call:answer', { to: remoteUser, answer: pcRef.current.localDescription });
        if (alive) setStatus('Connecting...');
      } catch (e) {
        console.error('handleOffer error:', e.message);
      }
    };

    const init = async () => {
      // Step 1: get mic
      let stream;
      try {
        setStatus('Requesting microphone...');
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
      } catch (err) {
        if (!alive) return;
        if (err.name === 'NotAllowedError') setError('Microphone permission denied.');
        else if (err.name === 'NotFoundError') setError('No microphone found.');
        else setError(`Mic error: ${err.message}`);
        onCallEnd();
        return;
      }

      if (!alive) { stream.getTracks().forEach(t => t.stop()); return; }
      streamRef.current = stream;

      // Step 2: create peer connection
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      });
      pcRef.current = pc;

      // Add local tracks
      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      pc.ontrack = (event) => {
        if (!audioRef.current) audioRef.current = new Audio();
        audioRef.current.srcObject = event.streams[0];
        audioRef.current.autoplay = true;
        audioRef.current.play().catch(() => {});
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('call:ice-candidate', { to: remoteUser, candidate: event.candidate });
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (!alive) return;
        const s = pc.iceConnectionState;
        console.log('ICE state:', s);
        if (s === 'connected' || s === 'completed') {
          setIsConnected(true);
          setStatus('Connected');
          if (!timerRef.current) {
            timerRef.current = setInterval(() => setCallDuration(p => p + 1), 1000);
          }
        } else if (s === 'failed') {
          setError('Connection failed. Check your network.');
        } else if (s === 'disconnected') {
          setStatus('Reconnecting...'); setIsConnected(false);
        }
      };

      // Step 3a: initiator — send offer now that stream + PC are ready
      if (isInitiator) {
        try {
          setStatus('Calling...');
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('call:offer', { to: remoteUser, offer: pc.localDescription });
          setStatus('Ringing...');
        } catch (err) {
          if (alive) setError(`Failed to start call: ${err.message}`);
        }

      // Step 3b: responder — process any offer that arrived while we were getting mic
      } else {
        setStatus('Connecting...');
        if (pendingOfferRef.current) {
          console.log('🔄 Processing queued offer');
          await handleOffer(pendingOfferRef.current);
          pendingOfferRef.current = null;
        }
      }
    };

    init();

    return () => {
      alive = false;
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
      if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
      if (audioRef.current) { audioRef.current.srcObject = null; audioRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEndCall = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    socket.emit('call:end', { to: remoteUser });
    onCallEnd();
  };

  const handleToggleMute = () => {
    if (streamRef.current) {
      streamRef.current.getAudioTracks().forEach(t => { t.enabled = !t.enabled; });
      setIsMuted(m => !m);
    }
  };

  const formatTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  return (
    <div className="voice-call-container">
      <div className="voice-call-modal">
        <div className="call-header">
          <h2>📞 {remoteUser}</h2>
          {isConnected && <div className="call-duration">{formatTime(callDuration)}</div>}
        </div>
        {error && <div className="call-error"><p>{error}</p></div>}
        <div className="call-status">
          <div className={`status-icon ${isConnected ? 'connected' : 'connecting'}`}>
            {isConnected ? '🎤' : '⏳'}
          </div>
          <p>{isConnected ? `Connected · ${formatTime(callDuration)}` : status}</p>
        </div>
        <div className="call-controls">
          <button className={`control-btn mute-btn ${isMuted ? 'muted' : ''}`} onClick={handleToggleMute}>
            {isMuted ? '🔇 Unmute' : '🎤 Mute'}
          </button>
          <button className="control-btn end-call-btn" onClick={handleEndCall}>
            📵 End Call
          </button>
        </div>
      </div>
    </div>
  );
}

export default VoiceCall;