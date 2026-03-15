import { useState, useRef, useEffect } from 'react';

function ChatWindow({ messages, currentUser, onSendMessage, isConnected, inCall, channelName = 'general' }) {
  const [text, setText] = useState('');
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (text.trim() && isConnected) {
      onSendMessage(text.trim());
      setText('');
    }
  };

  const getInitials = (name) => name ? name.slice(0, 2).toUpperCase() : '??';

  const formatTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className={`chat-area${inCall ? " in-call" : ""}`}>
      <div className="chat-header">
        <span className="chat-header-icon">#</span>
        <span className="chat-header-name">{channelName}</span>
        <span className="chat-header-desc">· {messages.length} messages</span>
      </div>

      <div className="messages-area">
        {messages.length === 0 ? (
          <div className="empty-chat">
            <div className="empty-chat-icon">💬</div>
            <div className="empty-chat-text">No messages yet. Say hello!</div>
          </div>
        ) : (
          messages.map((msg, i) => {
            const isMe = msg.username === currentUser?.username;
            const showAvatar = i === 0 || messages[i - 1].username !== msg.username;
            return (
              <div key={msg.id} className="msg">
                <div className="msg-avatar" style={{ visibility: showAvatar ? 'visible' : 'hidden' }}>
                  {getInitials(msg.username)}
                </div>
                <div className="msg-body">
                  {showAvatar && (
                    <div className="msg-meta">
                      <span className={`msg-author ${isMe ? 'me' : ''}`}>{msg.username}</span>
                      <span className="msg-time">{formatTime(msg.timestamp)}</span>
                    </div>
                  )}
                  <div className="msg-text">{msg.text}</div>
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      <div className="message-input-area">
        <form onSubmit={handleSubmit}>
          <div className="message-input-wrap">
            <input
              className="message-input"
              type="text"
              placeholder={isConnected ? `Message #${channelName}` : 'Not connected...'}
              value={text}
              onChange={e => setText(e.target.value)}
              disabled={!isConnected}
            />
            <button className="send-btn" type="submit" disabled={!isConnected || !text.trim()}>
              Send
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default ChatWindow;