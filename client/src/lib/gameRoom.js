// The server knows a player's game and team per socket, set by join-game. A dropped
// connection (a phone asleep, Wi-Fi to mobile data, a server restart) comes back as a new
// socket that has joined nothing, so every move and charge after it would be ignored. Join
// now if connected, and again on every (re)connect. Returns the cleanup for the effect.
export function joinGameOnConnect(socket, gameCode) {
  const join = () => socket.emit('join-game', { gameCode })
  if (socket.connected) join()
  socket.on('connect', join)
  return () => socket.off('connect', join)
}
