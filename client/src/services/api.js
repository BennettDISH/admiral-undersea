import axios from 'axios'

// The session is an httpOnly cookie the server sets (fleet-kit), so every call carries it on its
// own and the page never holds a token.
const api = axios.create({
  baseURL: '/api'
})

// If the session is rejected, go to the sign-in page rather than leaving the player stuck on a
// page that cannot load. Not from the sign-in pages themselves, which say what went wrong and
// hold, so a failed Waypoint sign-in can't loop.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      if (!['/login', '/register', '/auth/callback'].includes(window.location.pathname)) {
        window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  }
)

// Until 2026-10 the session was a token kept in localStorage. A page that still holds one hands
// it to the server once, with its first /me, and the server swaps it for the session cookie;
// then it is deleted here (with the cached user), so nobody is signed out by the move.
const OLD_TOKEN = 'token'
const OLD_USER = 'user'

export const auth = {
  login: (username, password) => api.post('/auth/login', { username, password }),
  register: (email, username, password) => api.post('/auth/register', { email, username, password }),
  guest: () => api.post('/auth/guest'),
  logout: () => api.post('/auth/logout'),
  // { ssoEnabled, user } — user is null when nobody is signed in
  me: async () => {
    const old = localStorage.getItem(OLD_TOKEN)
    try {
      return await api.get('/auth/me', old ? { headers: { Authorization: `Bearer ${old}` } } : undefined)
    } finally {
      if (old) localStorage.removeItem(OLD_TOKEN)
      localStorage.removeItem(OLD_USER)
    }
  }
}

// Look-only admin views. The server answers 403 unless the account is a site admin.
export const admin = {
  me: () => api.get('/admin/me'),
  users: (params) => api.get('/admin/users', { params }),
  games: (params) => api.get('/admin/games', { params }),
  switches: () => api.get('/admin/switches')
}

export default api
