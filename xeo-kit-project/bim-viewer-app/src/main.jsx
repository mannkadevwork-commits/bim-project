import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './engine/installMeshoptDecoder.js'
import './engine/installWalkthroughPerformance.js'
import App from './App.jsx'
import './index.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
