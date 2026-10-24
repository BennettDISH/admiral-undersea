const { isIPv6 } = require('node:net');

/**
 * A small in-memory limiter: returns a function key -> true while under `max` hits per window.
 * Past `maxKeys` stored keys it forgets visitors whose window has passed, then the ones seen
 * least recently, so a flood of new keys can't reset everyone's limits at once.
 */
function rateLimiter({ windowMs, max, maxKeys = 10000 }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    const allowed = recent.length < max;
    if (allowed) recent.push(now);
    // Re-inserted so the Map runs from least to most recently seen.
    hits.delete(key);
    hits.set(key, recent);
    if (hits.size > maxKeys) {
      for (const [k, times] of hits) {
        if (now - times[times.length - 1] >= windowMs) hits.delete(k);
      }
      for (const k of hits.keys()) {
        if (hits.size <= maxKeys) break;
        hits.delete(k);
      }
    }
    return allowed;
  };
}

/**
 * The key to limit a visitor by. One IPv6 visitor usually holds a whole /64 (billions of
 * addresses), so IPv6 is counted by that prefix. IPv4, IPv4-mapped IPv6 (as plain IPv4) and
 * the rest of ::/80 (loopback) keep the full address.
 */
function ipKey(ip) {
  const address = String(ip).split('%')[0].toLowerCase();
  if (!isIPv6(address)) return address;
  // Expand to eight 16-bit words; a dotted IPv4 tail is the last two.
  const words = (part) => (part ? part.split(':') : []).flatMap((g) => {
    if (!g.includes('.')) return [parseInt(g, 16)];
    const [a, b, c, d] = g.split('.').map(Number);
    return [a * 256 + b, c * 256 + d];
  });
  const [head, tail] = address.split('::');
  const left = words(head);
  const right = words(tail);
  const all = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
  if (all.slice(0, 5).some((w) => w !== 0)) {
    return `${all.slice(0, 4).map((w) => w.toString(16)).join(':')}::/64`;
  }
  if (all[5] === 0xffff) return [all[6] >> 8, all[6] & 255, all[7] >> 8, all[7] & 255].join('.');
  return address;
}

module.exports = { rateLimiter, ipKey };
