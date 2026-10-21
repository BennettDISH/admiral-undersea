import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useState, useEffect } from 'react'
import Login from './pages/Login'
import Register from './pages/Register'
import Home from './pages/Home'
import CreateGame from './pages/CreateGame'
import JoinGame from './pages/JoinGame'
import Lobby from './pages/Lobby'
import Game from './pages/Game'
import AuthCallback from './pages/AuthCallback'
import Admin from './pages/Admin'
import TopBar from './components/TopBar'
import { auth } from './services/api'
import { disconnectSocket } from './services/socket'
import { HOLD_KEY, returnPath, startWaypoint } from './lib/signIn'
import { waypointLogoutUrl } from './lib/topBar'

// Signed out on a page that needs an account: the sign-in page, which goes on to Waypoint
// and comes back here.
function SignInFirst() {
  const { pathname, search } = useLocation()
  return <Navigate to="/login" replace state={{ from: { pathname, search } }} />
}

function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  // Whether sign-in goes through Waypoint, and Waypoint's address; null until the server says.
  const [sso, setSso] = useState({ enabled: null, authUrl: null })
  const location = useLocation()

  useEffect(() => {
    const storedUser = localStorage.getItem('user')
    if (storedUser) {
      setUser(JSON.parse(storedUser))
    }
    setLoading(false)
  }, [])

  // SSO is configured entirely server-side; ask whether it is on and where Waypoint lives.
  useEffect(() => {
    auth.config()
      .then(res => setSso({ enabled: !!res.data.ssoEnabled, authUrl: res.data.authUrl || null }))
      .catch(() => setSso({ enabled: false, authUrl: null }))
  }, [])

  const handleLogin = (userData) => {
    sessionStorage.removeItem(HOLD_KEY)
    setUser(userData)
    localStorage.setItem('user', JSON.stringify(userData))
  }

  const handleLogout = () => {
    setUser(null)
    localStorage.removeItem('user')
    localStorage.removeItem('token')
    // Drop the socket so the next user re-authenticates the handshake as themselves.
    disconnectSocket()
  }

  // Sign out on purpose: the sign-in page then waits for a click instead of going straight
  // back through Waypoint, which would sign you in again.
  const handleSignOut = () => {
    sessionStorage.setItem(HOLD_KEY, 'signed-out')
    handleLogout()
  }

  // This game's sign-out, then Waypoint's, which ends the session every game's sign-in reuses.
  const logoutUrl = waypointLogoutUrl(sso.authUrl)
  const handleSignOutAll = logoutUrl ? () => {
    handleSignOut()
    window.location.assign(logoutUrl)
  } : null

  if (loading) {
    return <div className="loading">Loading...</div>
  }

  const back = returnPath(location.pathname, location.search)

  return (
    <div className="app">
      <TopBar
        ready={sso.enabled !== null}
        user={user}
        onSignIn={sso.enabled ? () => startWaypoint({ back }) : null}
        onSwitchAccount={sso.enabled ? () => startWaypoint({ back, prompt: 'login' }) : null}
        onSignOut={handleSignOut}
        onSignOutAll={handleSignOutAll}
      />
      <Routes>
        <Route
          path="/login"
          element={<Login user={user} ssoEnabled={sso.enabled} onLogin={handleLogin} />}
        />
        <Route
          path="/register"
          element={user ? <Navigate to="/" /> : <Register onLogin={handleLogin} />}
        />
        <Route
          path="/auth/callback"
          element={<AuthCallback onLogin={handleLogin} />}
        />
        <Route
          path="/"
          element={user ? <Home user={user} /> : <SignInFirst />}
        />
        <Route
          path="/create"
          element={user ? <CreateGame user={user} /> : <SignInFirst />}
        />
        <Route
          path="/join"
          element={user ? <JoinGame user={user} /> : <SignInFirst />}
        />
        <Route
          path="/lobby/:code"
          element={user ? <Lobby user={user} /> : <SignInFirst />}
        />
        <Route
          path="/game/:code"
          element={user ? <Game user={user} /> : <SignInFirst />}
        />
        <Route
          path="/admin"
          element={user ? <Admin /> : <SignInFirst />}
        />
      </Routes>
    </div>
  )
}

export default App
