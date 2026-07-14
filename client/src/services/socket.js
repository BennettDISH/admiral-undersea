import { io } from 'socket.io-client'

const URL = import.meta.env.PROD ? '' : 'http://localhost:5000'

export const socket = io(URL, {
  autoConnect: false
})

// The server authenticates every socket with the same session token as the REST API.
export const connectSocket = () => {
  const token = localStorage.getItem('token')
  // If the socket is already open under a different identity (e.g. a new user logged
  // in on the same tab without a page reload), tear it down so the handshake re-runs
  // with the current token instead of keeping the previous user's server-side identity.
  if (socket.connected && socket.auth && socket.auth.token !== token) {
    socket.disconnect()
  }
  if (!socket.connected) {
    socket.auth = { token }
    socket.connect()
  }
}

export const disconnectSocket = () => {
  if (socket.connected) {
    socket.disconnect()
  }
}

// A rejected handshake (missing/expired token) means the session is dead — clear it
// and return to login instead of silently failing to connect.
socket.on('connect_error', (err) => {
  if (err?.message && /auth|token|session/i.test(err.message)) {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    if (window.location.pathname !== '/login') {
      window.location.href = '/login'
    }
  }
})

export default socket
