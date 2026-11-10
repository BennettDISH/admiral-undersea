import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import api, { admin } from '../services/api'
import { getAudio } from '../lib/audio'
import { useScene, useSoundUnlocked } from '../lib/useScene'
import { STATIONS, STATION_INFO, AI_LEVELS } from '../game/rules'
import { Portrait } from '../game/CrewPanel'
import { loadArt } from '../game/sprites'

// The deck: the title over a slow sonar sweep, "Come aboard" to open the sound, then the ways to
// play: the tutorial (a guided first dive), against the computer's boat (Easy, Normal or Hard, picked
// here), or crew against crew, and a code to join.
function Home() {
  const navigate = useNavigate()
  const location = useLocation()
  const [isAdmin, setIsAdmin] = useState(false)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState('')
  // the end of a tutorial sends its player here with the difficulty pick open
  const [picking, setPicking] = useState(Boolean(location.state?.pickLevel))
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
      const { openLobbies, lobbyCap, madeToday, dayCap } = res.data
      navigate(`/lobby/${res.data.game.code}`, { state: { openLobbies, lobbyCap, madeToday, dayCap } })
    } catch (err) {
      setError(err.response?.data?.error || 'Could not make a game')
    } finally {
      setBusy(null)
    }
  }

  const togglePick = () => {
    setPicking((p) => !p)
    getAudio().play('ui.lever', { vol: 0.6 })
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
            <button className="deck-card tutorial" onClick={() => start('tutorial')} disabled={busy !== null}>
              <span className="dc-title">Tutorial</span>
              <span className="dc-sub">A guided first dive against a training boat: the helm, listening, the torpedo room and the engine room, one at a time, and why you never charge in.</span>
              <span className="dc-go">{busy === 'tutorial' ? 'Making ready…' : 'Dive ▸'}</span>
            </button>
            <button className={`deck-card hunt ${picking ? 'on' : ''}`} onClick={togglePick} disabled={busy !== null} aria-expanded={picking} aria-controls="level-pick">
              <span className="dc-title">Play against AI</span>
              <span className="dc-sub">Your boat against the computer's. Take every station, or only one and let the auto-crew run the rest. Pick how sharp their crew is.</span>
              <span className="dc-go">{picking ? 'Pick their crew ▾' : 'Choose ▸'}</span>
            </button>
            <button className="deck-card crews" onClick={() => start('crews')} disabled={busy !== null}>
              <span className="dc-title">Crew against crew</span>
              <span className="dc-sub">Two boats of friends. Share a code; empty stations go to the auto-crew.</span>
              <span className="dc-go">{busy === 'crews' ? 'Making ready…' : 'Muster ▸'}</span>
            </button>
          </div>

          {picking && (
            <section id="level-pick" className="level-pick" aria-label="How sharp the computer's crew is">
              <h2>Their crew</h2>
              <div className="level-cards">
                {AI_LEVELS.map((l) => (
                  <button key={l.id} className={`level-card lv-${l.id}`} onClick={() => start(l.mode)} disabled={busy !== null}>
                    <span className="lv-head">
                      <span className="lv-name">{l.name}</span>
                      <span className="lv-pips" aria-hidden="true">{[1, 2, 3].map((n) => <i key={n} className={n <= l.pips ? 'on' : ''} />)}</span>
                    </span>
                    <span className="dc-sub">{l.sub}</span>
                    <span className="dc-go">{busy === l.mode ? 'Making ready…' : 'Dive ▸'}</span>
                  </button>
                ))}
              </div>
              <p className="hint">New to the boat? The tutorial takes about five minutes.</p>
            </section>
          )}

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
              <li>Everything you do makes noise. The enemy hears it as a bearing: a line from where they were, sharper the louder you are. At Full you are heard across the sea, and your own hydrophones go nearly deaf.</li>
              <li>Listen, plot where the lines cross, and mark it. The torpedo room fires on the mark from at least three cells off (a torpedo arms only then), and can steer a running torpedo.</li>
              <li>A torpedo's seeker hears loud boats near it. When one is coming, slow down, turn across its path and throw a decoy toward it.</li>
              <li>Five hits on the hull sinks a boat. Ten minutes on the clock; then the boat with more hull wins.</li>
            </ol>
          </section>
        </main>
      )}
    </div>
  )
}

export default Home
