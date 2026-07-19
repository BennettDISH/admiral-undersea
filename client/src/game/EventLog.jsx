// A shared, team-scoped feed of announcements (moves, attacks, surfaces, sonar/drone/silence).
// The crew's shared memory and the radio operator's transcript.
function EventLog({ entries }) {
  return (
    <div className="event-log">
      <h3>Event Log</h3>
      <div className="log-scroll">
        {entries.length === 0 ? (
          <span className="log-empty">No activity yet…</span>
        ) : (
          entries.slice(-40).map((e) => (
            <div key={e.id} className={`log-entry log-entry--${e.kind}`}>
              <span className="log-text">{e.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export default EventLog
