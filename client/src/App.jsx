import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useState, useEffect } from 'react'
import Login from './pages/Login'
import Register from './pages/Register'
import Home from './pages/Home'
import CreateGame from './pages/CreateGame'
import JoinGame from './pages/JoinGame'
import Lobby from './pages/Lobby'
import Game from './pages/Game'
import Admin from './pages/Admin'
import TopBar from './components/TopBar'
import { auth } from './services/api'
import { disconnectSocket } from './services/socket'
import { HOLD_KEY, returnPath, startWaypoint } from './lib/signIn'
import { logoutAllUrl } from './lib/topBar'

// Signed out on a page that needs an account: the sign-in page, which goes on to Waypoint
// and comes back here.
function SignInFirst() {
  const { pathname, search } = useLocation()
  return <Navigate to="/login" replace state={{ from: { pathname, search } }} />
}

// Who is signed in. The session is an httpOnly cookie the server sets (fleet-kit); this page
// only ever learns the account from /api/auth/me, asked once on load.
function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  // Whether sign-in goes through Waypoint; null until the server says.
  const [ssoEnabled, setSsoEnabled] = useState(null)
  const location = useLocation()

  useEffect(() => {
    auth.me()
      .then((res) => {
        setSsoEnabled(Boolean(res.data.ssoEnabled))
        setUser(res.data.user)
        // a sign-in that came back from Waypoint lifts the hold Sign out or a failure left
        if (res.data.user) sessionStorage.removeItem(HOLD_KEY)
      })
      .catch(() => setSsoEnabled(false))
      .finally(() => setLoading(false))
  }, [])

  // The game's own form, the guest button or Register signed in: the cookie is set already.
  const handleLogin = (userData) => {
    sessionStorage.removeItem(HOLD_KEY)
    setUser(userData)
  }

  // Signs out on the server (every device), then drops the socket so the next player
  // re-authenticates the handshake as themselves. False when the server could not sign out:
  // the page stays signed in and can try again.
  const signOutHere = async () => {
    try {
      await auth.logout()
    } catch {
      window.alert('Could not sign out. Try again.')
      return false
    }
    // the sign-in page then waits for a click instead of going straight back through
    // Waypoint, which would sign you in again
    sessionStorage.setItem(HOLD_KEY, 'signed-out')
    setUser(null)
    disconnectSocket()
    return true
  }

  const handleSignOut = () => { signOutHere() }

  // This game's sign-out, then Waypoint's, which ends the session every game's sign-in reuses.
  const handleSignOutAll = ssoEnabled ? async () => {
    if (await signOutHere()) window.location.assign(logoutAllUrl())
  } : null

  if (loading) {
    return <div className="loading">Loading...</div>
  }

  const back = returnPath(location.pathname, location.search)

  return (
    <div className="app">
      <TopBar
        ready={ssoEnabled !== null}
        user={user}
        ssoEnabled={ssoEnabled}
        onSignIn={ssoEnabled ? () => startWaypoint({ back }) : null}
        onSwitchAccount={ssoEnabled ? () => startWaypoint({ back, prompt: 'login' }) : null}
        onSignOut={handleSignOut}
        onSignOutAll={handleSignOutAll}
      />
      <Routes>
        <Route
          path="/login"
          element={<Login user={user} ssoEnabled={ssoEnabled} onLogin={handleLogin} />}
        />
        <Route
          path="/register"
          element={user ? <Navigate to="/" /> : <Register onLogin={handleLogin} />}
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
