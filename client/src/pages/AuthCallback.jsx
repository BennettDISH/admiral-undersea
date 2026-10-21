import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { auth } from '../services/api'
import { RETURN_KEY, HOLD_KEY, safeReturnPath } from '../lib/signIn'

function AuthCallback({ onLogin }) {
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const ran = useRef(false)

  useEffect(() => {
    // The code is single-use and the server clears its state cookie on the first post, so
    // this runs once.
    if (ran.current) return
    ran.current = true

    // A failed attempt keeps the sign-in page up rather than going straight back to
    // Waypoint, so a broken sign-in can't loop. Signing in clears it.
    const fail = (message) => {
      sessionStorage.setItem(HOLD_KEY, 'failed')
      setError(message)
    }

    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const state = params.get('state')

    if (!code || !state) {
      fail('Invalid SSO callback')
      return
    }

    // The state is validated server-side against an httpOnly cookie set at /sso/login.
    auth.ssoLogin(code, state)
      .then(res => {
        if (res.data.token) {
          localStorage.setItem('token', res.data.token)
        }
        // Back to the page that sent you to Waypoint (a game link, say), else home.
        const back = safeReturnPath(sessionStorage.getItem(RETURN_KEY))
        sessionStorage.removeItem(RETURN_KEY)
        onLogin(res.data.user)
        navigate(back, { replace: true })
      })
      .catch(() => {
        fail('SSO authentication failed')
      })
  }, [navigate, onLogin])

  if (error) {
    return (
      <div className="auth-page">
        <div className="auth-container">
          <h1>Admiral Undersea</h1>
          <h2>Authentication Error</h2>
          <div className="error-message">{error}</div>
          <a href="/login" style={{ color: '#00d4ff', textDecoration: 'none' }}>Back to Login</a>
        </div>
      </div>
    )
  }

  return (
    <div className="auth-page">
      <div className="auth-container">
        <h1>Admiral Undersea</h1>
        <h2>Signing in...</h2>
      </div>
    </div>
  )
}

export default AuthCallback
