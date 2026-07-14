import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { auth } from '../services/api'

function AuthCallback({ onLogin }) {
  const [error, setError] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const state = params.get('state')
    const savedState = sessionStorage.getItem('sso_state')

    if (!code || !state || state !== savedState) {
      setError('Invalid SSO callback')
      return
    }

    sessionStorage.removeItem('sso_state')

    auth.ssoLogin(code)
      .then(res => {
        if (res.data.token) {
          localStorage.setItem('token', res.data.token)
        }
        onLogin(res.data.user)
        navigate('/')
      })
      .catch(() => {
        setError('SSO authentication failed')
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
