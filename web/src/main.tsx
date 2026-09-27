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

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
