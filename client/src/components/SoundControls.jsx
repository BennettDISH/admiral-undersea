import { useSyncExternalStore } from 'react'
import { getAudio } from '../lib/audio'

// Mute and the music level (lib/audio.js keeps them for the next visit). In the game's header, and
// on the deck pages (App.jsx DeckSound), where the menu music and the sea already play.
export default function SoundControls() {
  const audio = getAudio()
  const prefs = useSyncExternalStore(audio.subscribe, audio.snapshot, audio.snapshot)
  return (
    <div className="sound-controls">
      <button type="button" className={`sound-toggle ${prefs.muted ? 'muted' : ''}`} onClick={() => audio.toggleMute()} aria-pressed={prefs.muted} aria-label={prefs.muted ? 'Sound off. Turn sound on' : 'Sound on. Mute'}>
        {prefs.muted ? '🔇' : '🔊'}
      </button>
      <label className="music-level" title="Music">
        <span>♪</span>
        <input type="range" min="0" max="1" step="0.05" value={prefs.music} onChange={(e) => audio.setPrefs({ music: Number(e.target.value) })} aria-label="Music level" />
      </label>
    </div>
  )
}
