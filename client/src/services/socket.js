import { io } from 'socket.io-client'

const URL = import.meta.env.PROD ? '' : 'http://localhost:5000'

// The server knows the socket by the same session cookie as the REST API, which the browser
// sends with the handshake. In development the socket goes to :5000 from Vite's :5173, so it
// asks for the cookie to be sent across origins too.
export const socket = io(URL, {
  autoConnect: false,
  withCredentials: !import.meta.env.PROD
})

// If the socket is already open as someone else (a new sign-in on the same tab without a page
// reload), tear it down so the handshake re-runs as the current player.
export const connectSocket = (userId) => {
  if (socket.connected && socket.__userId !== userId) {
    socket.disconnect()
  }
  if (!socket.connected) {
    socket.__userId = userId
    socket.connect()
  }
}

export const disconnectSocket = () => {
  if (socket.connected) {
    socket.disconnect()
  }
}

// A handshake refused for want of a session means the session is over: back to the sign-in
// page instead of silently failing to connect. (A session the server could not check is not
// that, and the socket tries again.)
socket.on('connect_error', (err) => {
  if (err?.message && /Authentication required|Invalid or expired session/.test(err.message)) {
    if (window.location.pathname !== '/login') {
      window.location.href = '/login'
    }
  }
})

export default socket
