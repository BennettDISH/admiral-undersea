// Plain-language role explanations (shown by the ? help) + shared role/direction metadata.
export const DIR_ARROW = { N: '⬆️', S: '⬇️', E: '➡️', W: '⬅️' }
export const DIR_NAME = { N: 'North', S: 'South', E: 'East', W: 'West' }

// Circuit groups get friendly colour names so "complete a circuit" is legible.
export const CIRCUIT_NAME = { A: 'Blue', B: 'Amber', C: 'Green', D: 'Purple' }

export const ROLE_HELP = {
  captain: {
    icon: '🧭', name: 'Captain',
    mission: 'Pilot the sub and pull the trigger — sink the enemy before they sink you.',
    how: [
      'Move N/S/E/W. You can’t cross your own trail, an island, or the map edge — if you get boxed in you must Surface.',
      'Once your First Mate fully charges a system, a USE button appears: fire torpedoes, drop/detonate mines, scan with drone/sonar, or slip away with Silence.',
      'Surface repairs all breakdowns and clears your trail, but announces your sector to the enemy.',
    ],
    tip: 'A torpedo can only reach a cell within 4 squares by water. Line the shot up with your Radio Operator’s read on the enemy.',
  },
  'first-mate': {
    icon: '⚡', name: 'First Mate',
    mission: 'Power up the sub’s systems so the Captain has something to fire.',
    how: [
      'Each time the Captain moves you may charge ONE system (turn-based), or spend a charge token (live).',
      'A system is READY when its bar fills — only then can the Captain use it.',
      'Choose your charge order around the plan: torpedoes to attack, sonar/drone to hunt, silence to escape.',
    ],
    tip: 'Pouring charges into one system gets a weapon online faster; spreading them keeps your options open.',
  },
  engineer: {
    icon: '🔧', name: 'Engineer',
    mission: 'Keep the reactor alive. Every move breaks a node — you decide which system takes the hit.',
    how: [
      'Each Captain move damages one node in that DIRECTION’s group. Click a node to take its system offline.',
      'An OFFLINE system can’t be used until it’s repaired.',
      'Nodes are grouped into coloured circuits. Break all four nodes of one colour and that whole circuit auto-repairs.',
      'If a direction fills up with no node left to break, the reactor overloads — 1 hull damage.',
    ],
    tip: 'Break systems you’re not about to use, and try to line up a colour so a batch repairs at once.',
  },
  'radio-operator': {
    icon: '📻', name: 'Radio Operator',
    mission: 'Hunt the enemy. You hear every move they make — pin down where they are.',
    how: [
      'The green cells on your map are every spot the enemy could currently be in.',
      'Each enemy move you hear shrinks that set — down to one or two cells means you’ve found them.',
      'When the enemy Surfaces you learn their sector; when they go Silent the guess widens again.',
      'Call out the enemy’s location so your Captain can line up a torpedo.',
    ],
    tip: 'Not sure? “Test a hunch” lets you guess a starting cell and traces the path from there — impossible guesses are rejected automatically.',
  },
}
