import axios from 'axios'

const api = axios.create({
  baseURL: '/api'
})

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers['Authorization'] = `Bearer ${token}`
  }
  return config
})

// If the session is rejected, clear it and bounce to login rather than leaving the
// user stuck with a dead token.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      if (window.location.pathname !== '/login') {
        window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  }
)

export const auth = {
  login: (username, password) => api.post('/auth/login', { username, password }),
  register: (email, username, password) => api.post('/auth/register', { email, username, password }),
  ssoLogin: (code) => api.post('/auth/sso-callback', { code }),
  me: () => api.get('/auth/me')
}

export default api
