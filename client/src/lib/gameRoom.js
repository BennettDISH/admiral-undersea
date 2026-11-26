// The server knows a player's game and team per socket, set by join-game. A dropped
// connection (a phone asleep, Wi-Fi to mobile data, a server restart) comes back as a new
// socket that has joined nothing, so every move and charge after it would be ignored. Join
// now if connected, and again on every (re)connect. Returns the cleanup for the effect.
export function joinGameOnConnect(socket, gameCode) {
  const join = () => joinGame(socket, gameCode)
  if (socket.connected) join()
  socket.on('connect', join)
  return () => socket.off('connect', join)
}

/** Join (or rejoin) a game's room; a seated player's join starts a stopped match's clock again. */
export function joinGame(socket, gameCode) {
  socket.emit('join-game', { gameCode })
}

// A match whose clock the server stopped because its ticks kept failing: the room hears
// 'match-error' with the match time it stopped at. The notice stays until the clock runs past
// that time again (someone rejoined) or this player's own rejoin brings a full view.
export const STALL_NOTE = 'The boat stalled: rejoin to carry on.'

/** The notice for a 'match-error': its words, and the match time the clock stopped at. */
export function stallNotice(payload, lastT) {
  const t = Number.isFinite(payload?.t) ? payload.t : Number.isFinite(lastT) ? lastT : 0
  return { message: STALL_NOTE, t }
}

/** Whether a view ends a stall notice: a full view after a join, or the clock past the stall. */
export const stallOver = (stall, view) => Boolean(view?.contacts) || (Number.isFinite(view?.t) && view.t > stall.t)

// A running match sends this team's view five times a second. A dropped connection (a phone
// out of signal) often leaves the socket looking open for half a minute, so going this long
// without a view is the sign, as is a socket the page knows is closed. Never while the clock is
// stopped by design: a tutorial step being read sends nothing, and a finished game nothing more.
export const LOST_AFTER_MS = 3000
export const LOST_NOTE = 'Connection lost: reconnecting… If it lasts, the auto-crew takes your stations.'

/** Whether to tell the player the connection is down. */
export function connectionLost({ connected, view, over, lastViewAt, now }) {
  if (!view || over || view.over || view.tutorial?.paused) return false
  if (!connected) return true
  return now - lastViewAt > LOST_AFTER_MS
}

// A game that has ended, opened by its code or lobby link (a link shared yesterday, a tutorial
// left): its lobby used to look ready, and Dive or Join this boat did nothing. What to say instead.
// boats: the team names (TEAM_INFO's boat). Null while the game can still be mustered or played.
export function endedNote(game, boats = {}) {
  if (!game || game.status !== 'finished') return null
  if (game.game_mode === 'tutorial') return 'This training dive is over.'
  const boat = game.winner_team && boats[game.winner_team]
  return boat ? `This game is over: the ${boat} won.` : 'This game is over.'
}
