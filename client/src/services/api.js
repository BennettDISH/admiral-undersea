import axios from 'axios'

const api = axios.create({
  baseURL: '/api'
})

api.interceptors.request.use((config) => {
  const user = localStorage.getItem('user')
  if (user) {
    const { id } = JSON.parse(user)
    config.headers['x-user-id'] = id
  }
  return config
})

export const auth = {
  login: (username, password) => api.post('/auth/login', { username, password }),
  register: (email, username, password) => api.post('/auth/register', { email, username, password }),
  me: () => api.get('/auth/me')
}

export default api
