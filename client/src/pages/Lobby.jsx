import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import api from '../services/api'
import socket, { connectSocket } from '../services/socket'

const ROLES = [
  { id: 'captain', name: 'Captain', required: true, description: 'Plots course and commands the crew' },
  { id: 'first-mate', name: 'First Mate', required: false, description: 'Charges weapon and detection systems' },
  { id: 'engineer', name: 'Engineer', required: false, description: 'Manages submarine systems and repairs' },
  { id: 'radio-operator', name: 'Radio Operator', required: false, description: 'Tracks enemy submarine movements' }
]

function Lobby({ user }) {
  const { code } = useParams()
  const navigate = useNavigate()
  const [game, setGame] = useState(null)
  const [players, setPlayers] = useState([])
  const [selectedTeam, setSelectedTeam] = useState(null)
  const [selectedRole, setSelectedRole] = useState(null)
  const [automatedRoles, setAutomatedRoles] = useState(['first-mate', 'engineer', 'radio-operator'])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadGame()
    connectSocket()

    socket.emit('join-game', { gameCode: code, userId: user.id, username: user.username })

    socket.on('player-joined', ({ userId, username }) => {
      console.log(`${username} joined`)
      loadGame()
    })

    socket.on('player-left', ({ username }) => {
      console.log(`${username} left`)
      loadGame()
    })

    socket.on('team-updated', () => loadGame())
    socket.on('role-updated', () => loadGame())
    socket.on('game-started', (state) => {
      navigate(`/game/${code}`)
    })

    return () => {
      socket.off('player-joined')
      socket.off('player-left')
      socket.off('team-updated')
      socket.off('role-updated')
      socket.off('game-started')
    }
  }, [code, user])

  const loadGame = async () => {
    try {
      const response = await api.get(`/games/${code}`)
      setGame(response.data.game)
      setPlayers(response.data.players)

      const myPlayer = response.data.players.find(p => p.user_id === user.id)
      if (myPlayer) {
        setSelectedTeam(myPlayer.team)
        setSelectedRole(myPlayer.role)
      }
    } catch (err) {
      setError('Failed to load game')
    } finally {
      setLoading(false)
    }
  }

  const handleSelectTeam = (team) => {
    setSelectedTeam(team)
    socket.emit('select-team', { gameCode: code, userId: user.id, team })
  }

  const handleSelectRole = (role) => {
    setSelectedRole(role)
    setAutomatedRoles(prev => prev.filter(r => r !== role))
    socket.emit('select-role', { gameCode: code, userId: user.id, role })
  }

  const toggleAutomatedRole = (role) => {
    if (role === 'captain') return
    setAutomatedRoles(prev =>
      prev.includes(role) ? prev.filter(r => r !== role) : [...prev, role]
    )
  }

  const handleStartGame = () => {
    socket.emit('start-game', { gameCode: code, automatedRoles })
  }

  const isCreator = game?.created_by === user.id
  const teamPlayers = (team) => players.filter(p => p.team === team)
  const canStart = players.some(p => p.team === 'alpha' && p.role === 'captain') &&
                   players.some(p => p.team === 'bravo' && p.role === 'captain')

  if (loading) return <div className="loading">Loading...</div>
  if (error) return <div className="error-page">{error}</div>

  return (
    <div className="lobby-page">
      <header className="lobby-header">
        <h1>Game Lobby</h1>
        <div className="game-code">
          <span>Code:</span>
          <strong>{code}</strong>
        </div>
      </header>

      <div className="game-settings">
        <span className={`setting-badge ${game?.same_room ? 'same-room' : 'online'}`}>
          {game?.same_room ? '🏠 Same Room' : '🌐 Online'}
        </span>
        <span className={`setting-badge ${game?.game_mode}`}>
          {game?.game_mode === 'live' ? '⚡ Live' : '🔄 Turn-Based'}
        </span>
      </div>

      <div className="teams-container">
        <div className={`team-card alpha ${selectedTeam === 'alpha' ? 'selected' : ''}`}>
          <h2>Team Alpha</h2>
          <button
            className="join-team-btn"
            onClick={() => handleSelectTeam('alpha')}
            disabled={selectedTeam === 'alpha'}
          >
            {selectedTeam === 'alpha' ? 'Joined' : 'Join Team'}
          </button>

          <div className="team-players">
            {teamPlayers('alpha').map(p => (
              <div key={p.user_id} className="player-row">
                <span className="player-name">{p.username}</span>
                <span className="player-role">{p.role || 'Selecting...'}</span>
              </div>
            ))}
          </div>

          {selectedTeam === 'alpha' && (
            <div className="role-selection">
              <h3>Select Your Role</h3>
              {ROLES.map(role => (
                <button
                  key={role.id}
                  className={`role-btn ${selectedRole === role.id ? 'selected' : ''}`}
                  onClick={() => handleSelectRole(role.id)}
                >
                  <span className="role-name">{role.name}</span>
                  {role.required && <span className="required-badge">Required</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className={`team-card bravo ${selectedTeam === 'bravo' ? 'selected' : ''}`}>
          <h2>Team Bravo</h2>
          <button
            className="join-team-btn"
            onClick={() => handleSelectTeam('bravo')}
            disabled={selectedTeam === 'bravo'}
          >
            {selectedTeam === 'bravo' ? 'Joined' : 'Join Team'}
          </button>

          <div className="team-players">
            {teamPlayers('bravo').map(p => (
              <div key={p.user_id} className="player-row">
                <span className="player-name">{p.username}</span>
                <span className="player-role">{p.role || 'Selecting...'}</span>
              </div>
            ))}
          </div>

          {selectedTeam === 'bravo' && (
            <div className="role-selection">
              <h3>Select Your Role</h3>
              {ROLES.map(role => (
                <button
                  key={role.id}
                  className={`role-btn ${selectedRole === role.id ? 'selected' : ''}`}
                  onClick={() => handleSelectRole(role.id)}
                >
                  <span className="role-name">{role.name}</span>
                  {role.required && <span className="required-badge">Required</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {selectedTeam && (
        <div className="automation-section">
          <h3>Automated Roles</h3>
          <p>Roles without players will be automated:</p>
          <div className="automation-toggles">
            {ROLES.filter(r => !r.required).map(role => (
              <label key={role.id} className="toggle-label">
                <input
                  type="checkbox"
                  checked={automatedRoles.includes(role.id)}
                  onChange={() => toggleAutomatedRole(role.id)}
                  disabled={selectedRole === role.id}
                />
                <span>{role.name}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {isCreator && (
        <button
          className="start-game-btn"
          onClick={handleStartGame}
          disabled={!canStart}
        >
          {canStart ? 'Start Game' : 'Waiting for Captains...'}
        </button>
      )}

      <button className="back-btn" onClick={() => navigate('/')}>
        Leave Lobby
      </button>
    </div>
  )
}

export default Lobby
