import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../services/api'

function JoinGame() {
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleJoin = async (e) => {
    e.preventDefault()
    if (!code.trim()) {
      setError('Please enter a game code')
      return
    }

    setLoading(true)
    setError('')

    try {
      await api.get(`/games/${code.toUpperCase()}`)
      navigate(`/lobby/${code.toUpperCase()}`)
    } catch (err) {
      setError(err.response?.data?.error || 'Game not found')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="join-game-page">
      <h1>Join Game</h1>

      {error && <div className="error-message">{error}</div>}

      <form onSubmit={handleJoin}>
        <div className="form-group">
          <label htmlFor="code">Game Code</label>
          <input
            type="text"
            id="code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="Enter 6-character code"
            maxLength={6}
            autoComplete="off"
          />
        </div>

        <button type="submit" disabled={loading}>
          {loading ? 'Joining...' : 'Join Game'}
        </button>
      </form>

      <button className="back-btn" onClick={() => navigate('/')}>
        Back
      </button>
    </div>
  )
}

export default JoinGame
