import { useState, useEffect, useRef } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'
import { auth } from '../services/api'
import { HOLD_KEY, AUTO_KEY, holdReason, goStraightToWaypoint, returnPath, startWaypoint } from '../lib/signIn'

// Sign-in is Waypoint's job. With SSO configured, arriving here signed out goes straight to
// Waypoint, whose own page takes the password or offers "Continue as guest", so the game has
// no form of its own to type a password into. After Sign out or a failed attempt the page
// waits for a click instead. The game's old password form, guest button and Register are
// kept behind ?local for now; without SSO they are the whole page, as before.
function Login({ user, ssoEnabled, onLogin }) {
  const location = useLocation()
  const wantsLocal = new URLSearchParams(location.search).has('local')
  const [hold] = useState(() => holdReason(sessionStorage.getItem(HOLD_KEY)))
  const [lastAutoAt] = useState(() => sessionStorage.getItem(AUTO_KEY))
  const started = useRef(false)
  const from = location.state?.from
  const back = from ? returnPath(from.pathname, from.search) : null

  const straight = !user && goStraightToWaypoint({ ssoEnabled, hold, wantsLocal, lastAutoAt })
  useEffect(() => {
    if (straight && !started.current) {
      started.current = true
      startWaypoint({ back, automatic: true })
    }
  })

  if (user && !wantsLocal) {
    return <Navigate to={back || '/'} replace />
  }

  if (ssoEnabled === null || straight) {
    return (
      <div className="auth-page">
        <div className="auth-container">
          <h1>Admiral Undersea</h1>
          <h2>{straight ? 'Taking you to Waypoint…' : 'Loading…'}</h2>
        </div>
      </div>
    )
  }

  if (!ssoEnabled || wantsLocal) {
    return <LocalSignIn ssoEnabled={ssoEnabled} onLogin={onLogin} />
  }

  return (
    <div className="auth-page">
      <div className="auth-container">
        <h1>Admiral Undersea</h1>
        <h2>
          {hold === 'signed-out' ? 'You are signed out.'
            : hold === 'failed' ? 'Waypoint sign-in did not finish. Try again.'
            : 'Sign in with your Waypoint account, or play as a guest.'}
        </h2>
        <button type="button" className="sso-primary" onClick={() => startWaypoint({ back })} autoFocus>
          Continue with Waypoint
        </button>
      </div>
    </div>
  )
}

// The game's own form, one-click guest and Register, from before sign-in moved to Waypoint.
function LocalSignIn({ ssoEnabled, onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const response = await auth.login(username, password)
      if (response.data.token) {
        localStorage.setItem('token', response.data.token)
      }
      onLogin(response.data.user)
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  const handleGuest = async () => {
    setError('')
    setLoading(true)
    try {
      const response = await auth.guest()
      if (response.data.token) {
        localStorage.setItem('token', response.data.token)
      }
      onLogin(response.data.user)
    } catch (err) {
      setError(err.response?.data?.error || 'Could not start a guest session')
      setLoading(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-container">
        <h1>Admiral Undersea</h1>
        <h2>Login</h2>

        {error && <div className="error-message">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="username">Username</label>
            <input
              type="text"
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          <button type="submit" disabled={loading}>
            {loading ? 'Logging in...' : 'Login'}
          </button>
        </form>

        {ssoEnabled && (
          <>
            <div className="sso-divider">
              <span>or</span>
            </div>
            <button
              type="button"
              className="sso-button"
              onClick={() => startWaypoint()}
            >
              Sign in with Waypoint
            </button>
            <button type="button" onClick={handleGuest} disabled={loading} style={{ width: '100%', marginTop: '0.5rem' }}>
              {loading ? 'Starting...' : 'Continue as guest'}
            </button>
            <p style={{ fontSize: '0.8rem', textAlign: 'center', marginTop: '0.5rem', opacity: 0.7 }}>
              No account needed. Keep it later by adding a username and password.
            </p>
          </>
        )}

        <p className="auth-link">
          Don't have an account? <Link to="/register?local">Register</Link>
        </p>
      </div>
    </div>
  )
}

export default Login
