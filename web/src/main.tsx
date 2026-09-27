import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { loadLatestScene, startPersisting } from './edit/persist'
import { startEditing } from './edit/useEdit'
// ui.css first: it is the extracted stylesheet and root.css corrects for the
// one thing React changes about the page's geometry, so it has to win.
import './styles/ui.css'
import './styles/root.css'

// The scene, once per page and outside React: StrictMode mounts every
// component twice in development, and a second `startPersisting` would be two
// savers racing each other into the same folder. In this order, because the
// saver must not see the restored scene as an edit to write back, and the
// editor must open after the saver so a Clear reaches the saver first.
void loadLatestScene().finally(() => {
  startPersisting()
  startEditing()
})

// The engine starts a take with `video.play()` and never catches it, so a
// pause that lands before playback begins — every take swap, undo and detach
// rebuilds the clip — rejects with an AbortError nobody is listening for. It
// is the browser saying the pause won, which is what was asked. Only that one
// is absorbed: any other rejection still reaches the console and the checks.
window.addEventListener('unhandledrejection', (e) => {
  const r: unknown = e.reason
  if (r instanceof DOMException && r.name === 'AbortError'
      && r.message.includes('interrupted by a call to pause()')) e.preventDefault()
})

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
