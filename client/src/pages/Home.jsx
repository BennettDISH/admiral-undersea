import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { admin } from '../services/api'

function Home() {
  const navigate = useNavigate()
  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    admin.me().then((res) => setIsAdmin(res.data.isAdmin === true)).catch(() => setIsAdmin(false))
  }, [])

  return (
    <div className="home-page">
      {/* The arcade link and the account (name, sign out) live in the top bar. */}
      <header className="header">
        <h1>Admiral Undersea</h1>
        {isAdmin && (
          <div className="user-info">
            <button onClick={() => navigate('/admin')} className="logout-btn">Admin</button>
          </div>
        )}
      </header>

      <main className="main-content">
        <div className="game-options">
          <div className="option-card">
            <h2>Create Game</h2>
            <p>Start a new game and invite friends to join</p>
            <button className="primary-btn" onClick={() => navigate('/create')}>
              Create
            </button>
          </div>

          <div className="option-card">
            <h2>Join Game</h2>
            <p>Enter a game code to join an existing game</p>
            <button className="primary-btn" onClick={() => navigate('/join')}>
              Join
            </button>
          </div>
        </div>
      </main>
    </div>
  )
}

export default Home
