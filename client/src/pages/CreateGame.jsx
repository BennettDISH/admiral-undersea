import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../services/api'
import { useScene } from '../lib/useScene'
import { AI_LEVELS } from '../game/rules'

const MODES = [
  ...AI_LEVELS.map((l) => ({ id: l.mode, title: `Against AI: ${l.name}`, sub: l.sub })),
  { id: 'crews', title: 'Crew against crew', sub: 'Two boats of friends; empty stations go to the auto-crew.' },
]

// Making a game by hand (the deck makes one in a click): how it is played, and whether the
// crew share a room (then nobody needs the in-game calls as much).
function CreateGame() {
  const navigate = useNavigate()
  useScene('menu')
  const [gameMode, setGameMode] = useState('vs-ai-normal')
  const [sameRoom, setSameRoom] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleCreate = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await api.post('/games/create', { sameRoom, gameMode })
      const { openLobbies, lobbyCap, madeToday, dayCap } = response.data
      navigate(`/lobby/${response.data.game.code}`, { state: { openLobbies, lobbyCap, madeToday, dayCap } })
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create game')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="create-game-page deck-page">
      <h1>Make a game</h1>
      {error && <div className="error-message">{error}</div>}
      <div className="mode-grid" role="radiogroup" aria-label="How to play">
        {MODES.map((m) => (
          <button key={m.id} role="radio" aria-checked={gameMode === m.id} className={`mode-card ${gameMode === m.id ? 'on' : ''}`} onClick={() => setGameMode(m.id)}>
            <span className="dc-title">{m.title}</span>
            <span className="dc-sub">{m.sub}</span>
          </button>
        ))}
      </div>
      <label className="room-toggle">
        <input type="checkbox" checked={sameRoom} onChange={(e) => setSameRoom(e.target.checked)} />
        <span>We are all in the same room</span>
      </label>
      <div className="deck-row">
        <button className="primary" onClick={handleCreate} disabled={loading}>{loading ? 'Making ready…' : 'Make it'}</button>
        <button className="deck-small" onClick={() => navigate('/')}>Back</button>
      </div>
    </div>
  )
}

export default CreateGame
