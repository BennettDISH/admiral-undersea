import { io } from 'socket.io-client'

const URL = import.meta.env.PROD ? '' : 'http://localhost:5000'

export const socket = io(URL, {
  autoConnect: false
})

export const connectSocket = () => {
  if (!socket.connected) {
    socket.connect()
  }
}

export const disconnectSocket = () => {
  if (socket.connected) {
    socket.disconnect()
  }
}

export default socket
