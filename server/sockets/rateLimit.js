// How many events one socket may send. Socket.io hands every event straight to its handler,
// and several handlers query the database or broadcast to the whole room (each lobby
// broadcast makes every player there reload the game), so one client looping an emit could
// swamp the server and everyone sharing its games. Play is click-paced and stays far under
// this; events past it are dropped.
const SOCKET_BURST = 20;
const SOCKET_PER_SECOND = 10;

// A token bucket: `burst` events at once, refilling at `perSecond`. take() spends one and
// says whether there was one to spend.
function tokenBucket({ burst = SOCKET_BURST, perSecond = SOCKET_PER_SECOND, now = Date.now() } = {}) {
  let tokens = burst;
  let at = now;
  return function take(t = Date.now()) {
    tokens = Math.min(burst, tokens + (Math.max(0, t - at) / 1000) * perSecond);
    at = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

module.exports = { tokenBucket, SOCKET_BURST, SOCKET_PER_SECOND };
