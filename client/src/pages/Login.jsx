import { useState } from 'react'
import { Link } from 'react-router-dom'
import { auth } from '../services/api'

const AUTH_SERVICE_URL = import.meta.env.VITE_AUTH_SERVICE_URL
const SSO_CLIENT_ID = import.meta.env.VITE_SSO_CLIENT_ID

function Login({ onLogin }) {
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

        {AUTH_SERVICE_URL && (
          <>
            <div className="sso-divider">
              <span>or</span>
            </div>
            <button
              type="button"
              className="sso-button"
              onClick={() => {
                const state = crypto.randomUUID()
                sessionStorage.setItem('sso_state', state)
                const params = new URLSearchParams({
                  client_id: SSO_CLIENT_ID,
                  redirect_uri: `${window.location.origin}/auth/callback`,
                  state
                })
                window.location.href = `${AUTH_SERVICE_URL}/oauth/authorize?${params}`
              }}
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
