import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api, { admin } from '../services/api'
import { getAudio } from '../lib/audio'
import { useScene, useSoundUnlocked } from '../lib/useScene'
import { STATIONS, STATION_INFO } from '../game/rules'
import { Portrait } from '../game/CrewPanel'
import { loadArt } from '../game/sprites'

// The deck: the title over a slow sonar sweep, "Come aboard" to open the sound, then the ways to
// play: against the AI's boat (a green or a veteran crew) or crew against crew, and a code to join.
function Home() {
  const navigate = useNavigate()
  const [isAdmin, setIsAdmin] = useState(false)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState('')
  const unlocked = useSoundUnlocked()
  useScene('menu')
  useEffect(() => { loadArt() }, [])

  useEffect(() => {
    admin.me().then((res) => setIsAdmin(res.data.isAdmin === true)).catch(() => setIsAdmin(false))
  }, [])

  const aboard = () => {
    const audio = getAudio()
    audio.unlock()
    audio.play('ui.lever')
  }

  const start = async (gameMode) => {
    setBusy(gameMode)
    setError('')
    try {
      const res = await api.post('/games/create', { gameMode, sameRoom: false })
      navigate(`/lobby/${res.data.game.code}`, { state: { openLobbies: res.data.openLobbies, lobbyCap: res.data.lobbyCap } })
    } catch (err) {
      setError(err.response?.data?.error || 'Could not make a game')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="home-page deck">
      <div className="deck-sonar" aria-hidden="true"><span className="sweep" /><span className="blip b1" /><span className="blip b2" /><span className="blip b3" /></div>
      <div className="deck-sub" aria-hidden="true" />
      <div className="deck-bubbles" aria-hidden="true">{Array.from({ length: 14 }, (_, i) => <i key={i} style={{ '--i': i }} />)}</div>

      <header className="deck-title">
        <h1>Admiral Undersea</h1>
        <p>Two boats. One dark sea. Every sound gives you away.</p>
      </header>

      {!unlocked ? (
        <div className="aboard">
          <button className="aboard-btn" onClick={aboard}>
            <span className="aboard-ring" />
            Come aboard
          </button>
          <p className="hint">Sound on: the hunt is played by ear.</p>
        </div>
      ) : (
        <main className="deck-menu">
          {error && <div className="error-message">{error}</div>}
          <div className="deck-cards">
            <button className="deck-card hunt" onClick={() => start('vs-ai')} disabled={busy !== null}>
              <span className="dc-title">Hunt the AI</span>
              <span className="dc-sub">Your boat against a green enemy crew. Take every station, or only one and let the auto-crew run the rest.</span>
              <span className="dc-go">{busy === 'vs-ai' ? 'Making ready…' : 'Dive ▸'}</span>
            </button>
            <button className="deck-card veteran" onClick={() => start('vs-ai-veteran')} disabled={busy !== null}>
              <span className="dc-title">Hunt a veteran</span>
              <span className="dc-sub">The same, against a sharp crew that pings early and shoots straight.</span>
              <span className="dc-go">{busy === 'vs-ai-veteran' ? 'Making ready…' : 'Dive ▸'}</span>
            </button>
            <button className="deck-card crews" onClick={() => start('crews')} disabled={busy !== null}>
              <span className="dc-title">Crew against crew</span>
              <span className="dc-sub">Two boats of friends. Share a code; empty stations go to the auto-crew.</span>
              <span className="dc-go">{busy === 'crews' ? 'Making ready…' : 'Muster ▸'}</span>
            </button>
          </div>
          <div className="deck-row">
            <button className="deck-small" onClick={() => navigate('/join')}>Join with a code</button>
            {isAdmin && <button className="deck-small" onClick={() => navigate('/admin')}>Admin</button>}
          </div>

          <section className="how" aria-label="How a boat is crewed">
            <h2>Four stations, one boat</h2>
            <div className="how-grid">
              {STATIONS.map((s) => (
                <div key={s} className="how-card">
                  <Portrait station={s} size={64} />
                  <h3>{STATION_INFO[s].room}</h3>
                  <p>{STATION_INFO[s].job}</p>
                </div>
              ))}
            </div>
            <ol className="how-steps">
              <li>Everything you do makes noise. The enemy hears it as a bearing: a line from where they were, sharper the louder you are.</li>
              <li>Listen, plot where the lines cross, and mark it. The torpedo room fires on the mark and can steer a running torpedo.</li>
              <li>A torpedo in the water can be heard coming. Go to full speed across its path, throw a decoy, and repair what breaks.</li>
              <li>Five hits on the hull sinks a boat. Ten minutes on the clock; then the boat with more hull wins.</li>
            </ol>
          </section>
        </main>
      )}
    </div>
  )
}

export default Home
