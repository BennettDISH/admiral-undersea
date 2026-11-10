import { useEffect, useSyncExternalStore } from 'react'
import { getAudio } from './audio'

/** The page's soundscape: 'menu' on the deck and in the lobby, 'game' aboard. */
export function useScene(name) {
  useEffect(() => { getAudio().scene(name) }, [name])
}

/** Whether the first click has opened the sound yet (for the "come aboard" prompt). */
export function useSoundUnlocked() {
  const audio = getAudio()
  return useSyncExternalStore(audio.subscribe, () => audio.ready, () => false)
}
