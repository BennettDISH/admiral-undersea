import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../services/api'
import { useScene } from '../lib/useScene'

function JoinGame() {
  const navigate = useNavigate()
  useScene('menu')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleJoin = async (e) => {
    e.preventDefault()
    if (!code.trim()) {
      setError('Enter the six-letter code your crew shared')
      return
    }
    setLoading(true)
    setError('')
    try {
      await api.get(`/games/${code.toUpperCase()}`)
      navigate(`/lobby/${code.toUpperCase()}`)
    } catch (err) {
      setError(err.response?.data?.error || 'No game with that code')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="join-game-page deck-page">
      <h1>Join a crew</h1>
      {error && <div className="error-message">{error}</div>}
      <form onSubmit={handleJoin}>
        <div className="form-group">
          <label htmlFor="code">Game code</label>
          <input
            type="text"
            id="code"
            className="code-input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            placeholder="ABC123"
            maxLength={6}
            autoComplete="off"
          />
        </div>
        <button type="submit" className="primary" disabled={loading}>{loading ? 'Joining…' : 'Come aboard'}</button>
      </form>
      <button className="deck-small" onClick={() => navigate('/')}>Back</button>
    </div>
  )
}

export default JoinGame
