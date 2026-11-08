// What a blast feels like from our boat: which sounds play, and whether the screen shakes or
// flashes. A blast (the server's 'blast-resolved': { by, weapon, origin, results }) hurts a boat
// on its cell or next to it; one cell further out is a near miss, felt but not taken.

/** Seconds from our torpedo leaving its tube to its blast. */
export const TORPEDO_RUN = 0.7
/** Cells (counted like a king moves) at which a blast that missed us still shakes the boat. */
export const NEAR_MISS = 2

const reach = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))

/**
 * { launch, boom: 'hit' | 'far', vol, delay, shake: 'big' | 'small' | null, flash, creak } for one
 * blast, from `team`'s side, its boat at `position` (or unknown).
 */
export function blastFeedback(blast, team, position = null) {
  const ours = blast.results?.find((r) => r.team === team)
  const launch = blast.weapon === 'torpedo' && blast.by === team
  const delay = launch ? TORPEDO_RUN : 0
  if (ours?.damage > 0) return { launch, boom: 'hit', vol: 1, delay, shake: 'big', flash: true, creak: true }
  const near = position && blast.origin ? reach(position, blast.origin) <= NEAR_MISS : false
  return { launch, boom: 'far', vol: near ? 1 : 0.6, delay, shake: near ? 'small' : null, flash: false, creak: false }
}

/** The intercom answer's pitch for each station, so three confirmations are three voices. */
export const AYE_PITCH = { 'first-mate': 1, engineer: 0.93, 'radio-operator': 1.07 }
/** Seconds between two answers that arrive together, so they are heard one after another. */
export const AYE_GAP = 0.32

/** The radio operator's move cue: the enemy's heading as a pitch, as the game always had it. */
export const MOVE_HZ = { N: 440, S: 330, E: 550, W: 220 }
