import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../services/api'

function CreateGame({ user }) {
  const navigate = useNavigate()
  const [sameRoom, setSameRoom] = useState(null)
  const [gameMode, setGameMode] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleCreate = async () => {
    if (sameRoom === null || gameMode === null) {
      setError('Please select all options')
      return
    }

    setLoading(true)
    setError('')

    try {
      const response = await api.post('/games/create', {
        userId: user.id,
        sameRoom,
        gameMode
      })
      navigate(`/lobby/${response.data.game.code}`)
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create game')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="create-game-page">
      <h1>Create Game</h1>

      {error && <div className="error-message">{error}</div>}

      <div className="option-section">
        <h2>Are players in the same room?</h2>
        <div className="option-buttons">
          <button
            className={`option-btn ${sameRoom === true ? 'selected' : ''}`}
            onClick={() => setSameRoom(true)}
          >
            <span className="option-icon">🏠</span>
            <span className="option-label">Same Room</span>
            <span className="option-desc">Players can see each other's screens</span>
          </button>
          <button
            className={`option-btn ${sameRoom === false ? 'selected' : ''}`}
            onClick={() => setSameRoom(false)}
          >
            <span className="option-icon">🌐</span>
            <span className="option-label">Online</span>
            <span className="option-desc">Players are in different locations</span>
          </button>
        </div>
      </div>

      <div className="option-section">
        <h2>Game Mode</h2>
        <div className="option-buttons">
          <button
            className={`option-btn ${gameMode === 'live' ? 'selected' : ''}`}
            onClick={() => setGameMode('live')}
          >
            <span className="option-icon">⚡</span>
            <span className="option-label">Live</span>
            <span className="option-desc">Real-time simultaneous play</span>
          </button>
          <button
            className={`option-btn ${gameMode === 'turn-based' ? 'selected' : ''}`}
            onClick={() => setGameMode('turn-based')}
          >
            <span className="option-icon">🔄</span>
            <span className="option-label">Turn-Based</span>
            <span className="option-desc">Teams alternate turns</span>
          </button>
        </div>
      </div>

      <button
        className="create-btn"
        onClick={handleCreate}
        disabled={loading || sameRoom === null || gameMode === null}
      >
        {loading ? 'Creating...' : 'Create Game'}
      </button>

      <button className="back-btn" onClick={() => navigate('/')}>
        Back
      </button>
    </div>
  )
}

export default CreateGame
