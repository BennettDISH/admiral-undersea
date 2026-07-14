import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { auth } from '../services/api'

function Login({ onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [ssoEnabled, setSsoEnabled] = useState(false)

  // SSO is configured entirely server-side now; ask whether to show the button.
  useEffect(() => {
    auth.config()
      .then(res => setSsoEnabled(!!res.data.ssoEnabled))
      .catch(() => setSsoEnabled(false))
  }, [])

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
              onClick={() => { window.location.href = '/api/auth/sso/login' }}
            >
              Sign in with bennettdishman.com
            </button>
          </>
        )}

        <p className="auth-link">
          Don't have an account? <Link to="/register">Register</Link>
        </p>
      </div>
    </div>
  )
}

export default Login
