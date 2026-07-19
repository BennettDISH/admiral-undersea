import { useState } from 'react'
import { ROLE_HELP } from './roleInfo'

// A small "?" affordance that opens a plain-language explainer for a role.
function RoleHelp({ role }) {
  const [open, setOpen] = useState(false)
  const h = ROLE_HELP[role]
  if (!h) return null
  return (
    <span className="role-help">
      <button
        type="button"
        className="role-help-btn"
        aria-label={`How to play ${h.name}`}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
      >?</button>
      {open && (
        <>
          <div className="role-help-scrim" onClick={() => setOpen(false)} />
          <div className="role-help-pop" role="dialog">
            <div className="role-help-head">{h.icon} {h.name}</div>
            <p className="role-help-mission">{h.mission}</p>
            <ul className="role-help-how">{h.how.map((x, i) => <li key={i}>{x}</li>)}</ul>
            <p className="role-help-tip">💡 {h.tip}</p>
            <button type="button" className="role-help-close" onClick={() => setOpen(false)}>Got it</button>
          </div>
        </>
      )}
    </span>
  )
}

export default RoleHelp
