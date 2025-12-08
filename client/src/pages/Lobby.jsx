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
  const [selectedRoles, setSelectedRoles] = useState([])
  const [automatedRoles, setAutomatedRoles] = useState([])
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
    socket.on('roles-updated', () => loadGame())
    socket.on('game-started', (state) => {
      navigate(`/game/${code}`)
    })

    return () => {
      socket.off('player-joined')
      socket.off('player-left')
      socket.off('team-updated')
      socket.off('roles-updated')
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
        // Parse roles - could be comma-separated string or single role
        if (myPlayer.roles) {
          setSelectedRoles(myPlayer.roles.split(',').filter(r => r))
        } else if (myPlayer.role && myPlayer.role !== 'unassigned') {
          setSelectedRoles([myPlayer.role])
        }
      }
    } catch (err) {
      setError('Failed to load game')
    } finally {
      setLoading(false)
    }
  }

  const handleSelectTeam = (team) => {
    setSelectedTeam(team)
    setSelectedRoles([])
    setAutomatedRoles([])
    socket.emit('select-team', { gameCode: code, userId: user.id, team })
  }

  const toggleRole = (roleId) => {
    let newRoles
    if (selectedRoles.includes(roleId)) {
      newRoles = selectedRoles.filter(r => r !== roleId)
    } else {
      newRoles = [...selectedRoles, roleId]
      // If selecting a role, remove from automated
      setAutomatedRoles(prev => prev.filter(r => r !== roleId))
    }
    setSelectedRoles(newRoles)
    socket.emit('select-roles', { gameCode: code, userId: user.id, roles: newRoles })
  }

  const toggleAutomatedRole = (roleId) => {
    if (roleId === 'captain') return // Captain can't be automated

    let newAutomated
    if (automatedRoles.includes(roleId)) {
      newAutomated = automatedRoles.filter(r => r !== roleId)
    } else {
      newAutomated = [...automatedRoles, roleId]
      // If automating, remove from player's selected roles
      const newRoles = selectedRoles.filter(r => r !== roleId)
      setSelectedRoles(newRoles)
      socket.emit('select-roles', { gameCode: code, userId: user.id, roles: newRoles })
    }
    setAutomatedRoles(newAutomated)
    socket.emit('set-automated-roles', { gameCode: code, team: selectedTeam, automatedRoles: newAutomated })
  }

  const handleStartGame = () => {
    socket.emit('start-game', { gameCode: code })
  }

  const isCreator = game?.created_by === user.id
  const teamPlayers = (team) => players.filter(p => p.team === team)

  // Check if both teams have captains (either player or not automated means someone needs to play it)
  const teamHasCaptain = (team) => {
    const teamPlayersList = teamPlayers(team)
    return teamPlayersList.some(p => {
      const roles = p.roles ? p.roles.split(',') : (p.role ? [p.role] : [])
      return roles.includes('captain')
    })
  }

  const canStart = teamHasCaptain('alpha') && teamHasCaptain('bravo')

  // Get roles assigned to players on a team
  const getTeamRoleAssignments = (team) => {
    const assignments = {}
    ROLES.forEach(role => {
      assignments[role.id] = []
    })

    teamPlayers(team).forEach(player => {
      const roles = player.roles ? player.roles.split(',') : (player.role && player.role !== 'unassigned' ? [player.role] : [])
      roles.forEach(roleId => {
        if (assignments[roleId]) {
          assignments[roleId].push(player.username)
        }
      })
    })

    return assignments
  }

  if (loading) return <div className="loading">Loading...</div>
  if (error) return <div className="error-page">{error}</div>

  const alphaAssignments = getTeamRoleAssignments('alpha')
  const bravoAssignments = getTeamRoleAssignments('bravo')

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
        {/* Team Alpha */}
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
                <span className="player-role">
                  {p.roles || p.role || 'Selecting...'}
                </span>
              </div>
            ))}
          </div>

          {selectedTeam === 'alpha' && (
            <div className="role-selection">
              <h3>Role Assignment</h3>
              <div className="role-grid">
                {ROLES.map(role => {
                  const isSelected = selectedRoles.includes(role.id)
                  const isAutomated = automatedRoles.includes(role.id)
                  const assignedTo = alphaAssignments[role.id]

                  return (
                    <div key={role.id} className={`role-row ${isSelected ? 'selected' : ''} ${isAutomated ? 'automated' : ''}`}>
                      <div className="role-info">
                        <span className="role-name">{role.name}</span>
                        {role.required && <span className="required-badge">Required</span>}
                        {assignedTo.length > 0 && (
                          <span className="assigned-to">({assignedTo.join(', ')})</span>
                        )}
                      </div>
                      <div className="role-controls">
                        <label className="role-checkbox">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleRole(role.id)}
                            disabled={isAutomated}
                          />
                          <span>I'll play</span>
                        </label>
                        {!role.required && (
                          <label className="role-checkbox auto">
                            <input
                              type="checkbox"
                              checked={isAutomated}
                              onChange={() => toggleAutomatedRole(role.id)}
                            />
                            <span>Auto</span>
                          </label>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* Team Bravo */}
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
                <span className="player-role">
                  {p.roles || p.role || 'Selecting...'}
                </span>
              </div>
            ))}
          </div>

          {selectedTeam === 'bravo' && (
            <div className="role-selection">
              <h3>Role Assignment</h3>
              <div className="role-grid">
                {ROLES.map(role => {
                  const isSelected = selectedRoles.includes(role.id)
                  const isAutomated = automatedRoles.includes(role.id)
                  const assignedTo = bravoAssignments[role.id]

                  return (
                    <div key={role.id} className={`role-row ${isSelected ? 'selected' : ''} ${isAutomated ? 'automated' : ''}`}>
                      <div className="role-info">
                        <span className="role-name">{role.name}</span>
                        {role.required && <span className="required-badge">Required</span>}
                        {assignedTo.length > 0 && (
                          <span className="assigned-to">({assignedTo.join(', ')})</span>
                        )}
                      </div>
                      <div className="role-controls">
                        <label className="role-checkbox">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleRole(role.id)}
                            disabled={isAutomated}
                          />
                          <span>I'll play</span>
                        </label>
                        {!role.required && (
                          <label className="role-checkbox auto">
                            <input
                              type="checkbox"
                              checked={isAutomated}
                              onChange={() => toggleAutomatedRole(role.id)}
                            />
                            <span>Auto</span>
                          </label>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {isCreator && (
        <button
          className="start-game-btn"
          onClick={handleStartGame}
          disabled={!canStart}
        >
          {canStart ? 'Start Game' : 'Each team needs a Captain...'}
        </button>
      )}

      <button className="back-btn" onClick={() => navigate('/')}>
        Leave Lobby
      </button>
    </div>
  )
}

export default Lobby
