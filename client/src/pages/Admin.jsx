import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { admin } from '../services/api'
import { adminGate, FORBIDDEN_TEXT } from '../lib/adminGate'

// Look-only view of every account and game, for site admins, with the environment switches
// shown on or off. The server decides who that is (ADMIN_CENTRAL_USER_IDS); everyone else
// gets a plain "This page is for the site admin."

const when = (t) => (t ? new Date(t).toLocaleString() : '—')

const teamName = (game, team) =>
  team === 'alpha' ? game.team_alpha_name : team === 'bravo' ? game.team_bravo_name : team

function Pager({ data, onPage }) {
  if (!data) return null
  return (
    <div className="admin-pager">
      <button disabled={data.page <= 1} onClick={() => onPage(data.page - 1)}>Prev</button>
      <span>Page {data.page} of {data.totalPages} · {data.total} total</span>
      <button disabled={data.page >= data.totalPages} onClick={() => onPage(data.page + 1)}>Next</button>
    </div>
  )
}

function UsersTable({ users, onGames }) {
  if (users.length === 0) return <p className="admin-empty">No accounts match.</p>
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th>Name</th><th>Email</th><th>Sign-in</th><th>Joined</th>
            <th>Played</th><th>Won</th><th>Created</th><th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className={u.is_active ? '' : 'inactive'}>
              <td>{u.username}{u.is_active ? '' : ' (inactive)'}</td>
              <td>{u.email || '—'}</td>
              <td>{u.waypoint ? 'Waypoint' : 'Local'}</td>
              <td>{when(u.created_at)}</td>
              <td>{u.games_played}</td>
              <td>{u.games_won}</td>
              <td>{u.games_created}</td>
              <td>
                <button className="admin-link-btn" onClick={() => onGames(u)}>Games</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function GamesList({ games }) {
  if (games.length === 0) return <p className="admin-empty">No games match.</p>
  return (
    <div className="admin-games">
      {games.map((g) => (
        <div key={g.id} className="admin-game">
          <div className="admin-game-head">
            <strong className="admin-code">{g.code}</strong>
            <span className={`setting-badge status-${g.status}`}>{g.status}</span>
            <span className="setting-badge">{g.game_mode}</span>
            {g.same_room && <span className="setting-badge">same room</span>}
            {g.winner_team && <span className="admin-winner">Won by {teamName(g, g.winner_team)}</span>}
          </div>
          <div className="admin-game-meta">
            Created by {g.creator_name || '—'} · {when(g.created_at)}
            {g.started_at && <> · started {when(g.started_at)}</>}
            {g.ended_at && <> · ended {when(g.ended_at)}</>}
          </div>
          <div className="admin-teams">
            {['alpha', 'bravo'].map((team) => {
              const crew = g.players.filter((p) => p.team === team)
              return (
                <div key={team} className={`admin-team ${g.winner_team === team ? 'winner' : ''}`}>
                  <h4>{teamName(g, team)}</h4>
                  {crew.length === 0
                    ? <span className="admin-empty">No one</span>
                    : crew.map((p) => (
                      <div key={p.user_id}>
                        {p.username}
                        {p.roles && p.roles !== 'unassigned' && <span className="admin-roles"> · {p.roles}</span>}
                      </div>
                    ))}
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

function SwitchesTable({ switches }) {
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr><th>Switch</th><th>State</th><th>Set by</th></tr>
        </thead>
        <tbody>
          {switches.map((s) => (
            <tr key={s.name}>
              <td>{s.name}</td>
              <td>{s.on ? 'on' : 'off'}{s.note ? ` (${s.note})` : ''}</td>
              <td>{s.env}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// The page itself: nothing of the admin area renders until the server says this account is
// the site admin.
function Admin() {
  const navigate = useNavigate()
  const [isAdmin, setIsAdmin] = useState(null)

  useEffect(() => {
    admin.me().then((res) => setIsAdmin(res.data.isAdmin === true)).catch(() => setIsAdmin(false))
  }, [])

  const gate = adminGate({ signedIn: true, isAdmin })
  if (gate === 'show') return <AdminPanel />
  return (
    <div className="admin-page">
      {gate === 'forbidden'
        ? (
          <>
            <h1>{FORBIDDEN_TEXT}</h1>
            <button className="logout-btn" onClick={() => navigate('/')}>Back</button>
          </>
        )
        : <p className="admin-empty">Loading…</p>}
    </div>
  )
}

function AdminPanel() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab = ['games', 'switches'].includes(params.get('tab')) ? params.get('tab') : 'users'
  const q = params.get('q') || ''
  const page = Number(params.get('page')) || 1
  const status = params.get('status') || ''
  const user = params.get('user') || ''
  const userName = params.get('name') || ''

  const [draft, setDraft] = useState(q)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => { setDraft(q) }, [q])

  useEffect(() => {
    let live = true
    setLoading(true)
    setError('')
    const query = { q: q || undefined, page }
    const call = tab === 'games'
      ? admin.games({ ...query, status: status || undefined, user: user || undefined })
      : tab === 'switches' ? admin.switches() : admin.users(query)
    call
      .then((res) => { if (live) setData({ ...res.data, tab }) })
      .catch((err) => {
        if (!live) return
        setData(null)
        setError(err.response?.status === 403 ? FORBIDDEN_TEXT : (err.response?.data?.error || 'Could not load.'))
      })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [tab, q, page, status, user])

  const go = (next) => {
    const merged = { tab, q, status, user, name: userName, page: 1, ...next }
    const clean = {}
    for (const [k, v] of Object.entries(merged)) {
      if (v !== '' && v != null && !(k === 'page' && v === 1) && !(k === 'tab' && v === 'users')) clean[k] = String(v)
    }
    setParams(clean)
  }

  const switchTab = (t) => setParams(t === 'users' ? {} : { tab: t })

  return (
    <div className="admin-page">
      <header className="lobby-header">
        <h1>Admin</h1>
        <button className="logout-btn" onClick={() => navigate('/')}>Back</button>
      </header>
      <p className="admin-note">Look-only. Nothing here changes an account or a game.</p>

      <div className="admin-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'users'} className={tab === 'users' ? 'selected' : ''} onClick={() => switchTab('users')}>Users</button>
        <button role="tab" aria-selected={tab === 'games'} className={tab === 'games' ? 'selected' : ''} onClick={() => switchTab('games')}>Games</button>
        <button role="tab" aria-selected={tab === 'switches'} className={tab === 'switches' ? 'selected' : ''} onClick={() => switchTab('switches')}>Switches</button>
      </div>

      {tab !== 'switches' && <form className="admin-search" onSubmit={(e) => { e.preventDefault(); go({ q: draft.trim() }) }}>
        <input
          type="search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={tab === 'games' ? 'Code, creator or player' : 'Name or email'}
          aria-label="Search"
          maxLength={100}
        />
        {tab === 'games' && (
          <select value={status} onChange={(e) => go({ status: e.target.value })} aria-label="Status">
            <option value="">Any status</option>
            <option value="lobby">Lobby</option>
            <option value="playing">Playing</option>
            <option value="finished">Finished</option>
          </select>
        )}
        <button type="submit">Search</button>
      </form>}

      {tab === 'games' && user && (
        <div className="admin-filter">
          Games of {userName || `account ${user}`}
          <button className="admin-link-btn" onClick={() => go({ user: '', name: '' })}>Show all</button>
        </div>
      )}

      {error && <div className="error-message">{error}</div>}
      {loading && (!data || data.tab !== tab) && <p className="admin-empty">Loading…</p>}

      {data && data.tab === tab && (
        <>
          {tab === 'switches'
            ? <SwitchesTable switches={data.switches || []} />
            : tab === 'users'
              ? <UsersTable users={data.users || []} onGames={(u) => setParams({ tab: 'games', user: String(u.id), name: u.username })} />
              : <GamesList games={data.games || []} />}
          {tab !== 'switches' && <Pager data={data} onPage={(p) => go({ page: p })} />}
        </>
      )}
    </div>
  )
}

export default Admin
