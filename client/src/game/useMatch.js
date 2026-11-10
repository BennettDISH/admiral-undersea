import { useEffect, useRef, useState, useCallback } from 'react'
import api from '../services/api'
import socket, { connectSocket } from '../services/socket'
import { joinGameOnConnect } from '../lib/gameRoom'

const CONTACT_TTL = 45

/** Contacts by id, oldest first, without those past their time. */
export function mergeContacts(list, incoming, now) {
  const byId = new Map(list.map((c) => [c.id, c]))
  for (const c of incoming) byId.set(c.id, c)
  return [...byId.values()].filter((c) => now - c.t <= CONTACT_TTL).sort((a, b) => a.t - b.t || a.id - b.id)
}

/**
 * A match from the socket: the game row and our seat (REST), our team's view five times a
 * second, the plot's contacts, every 'fx' event to whoever listens (onFx), the end, and the
 * server's refusals.
 */
export function useMatch(code, user) {
  const [game, setGame] = useState(null)
  const [players, setPlayers] = useState([])
  const [seat, setSeat] = useState(null) // { team, roles }
  const [view, setView] = useState(null)
  const [contacts, setContacts] = useState([])
  const [over, setOver] = useState(null)
  const [refusal, setRefusal] = useState(null)
  const fxListeners = useRef(new Set())
  const viewRef = useRef(null)

  useEffect(() => {
    let gone = false
    api.get(`/games/${code}`).then((res) => {
      if (gone) return
      setGame(res.data.game)
      setPlayers(res.data.players)
      const me = res.data.players.find((p) => p.user_id === user.id)
      if (me) setSeat({ team: me.team, roles: (me.roles || '').split(',').filter((r) => r && r !== 'unassigned') })
      else setSeat({ team: null, roles: [] })
    }).catch(() => setSeat({ team: null, roles: [] }))

    connectSocket(user.id)
    const stopJoining = joinGameOnConnect(socket, code)
    const onView = (v) => {
      if (!v || v.v !== 2) return
      viewRef.current = v
      setView(v)
      if (v.contacts) setContacts(mergeContacts([], v.contacts, v.t))
      if (v.over) setOver((o) => o || v.over)
    }
    const onFx = (ev) => {
      if (ev.type === 'contact') setContacts((list) => mergeContacts(list, [ev.contact], viewRef.current?.t ?? ev.contact.t))
      for (const fn of fxListeners.current) fn(ev)
    }
    const onOver = ({ winner }) => setOver((o) => o || { winner })
    const onRefused = (r) => setRefusal({ ...r, at: Date.now() })
    socket.on('game-state', onView)
    socket.on('game-started', onView)
    socket.on('fx', onFx)
    socket.on('game-over', onOver)
    socket.on('action-rejected', onRefused)
    return () => {
      gone = true
      stopJoining()
      socket.off('game-state', onView)
      socket.off('game-started', onView)
      socket.off('fx', onFx)
      socket.off('game-over', onOver)
      socket.off('action-rejected', onRefused)
    }
  }, [code, user.id])

  const send = useCallback((event, payload = {}) => socket.emit(event, { gameCode: code, ...payload }), [code])
  const onFx = useCallback((fn) => { fxListeners.current.add(fn); return () => fxListeners.current.delete(fn) }, [])

  return { game, players, seat, view, contacts, over, refusal, send, onFx }
}
