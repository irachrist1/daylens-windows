import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import Today from './views/Today'
import Focus from './views/Focus'
import History from './views/History'
import Apps from './views/Apps'
import Insights from './views/Insights'
import Settings from './views/Settings'

export default function App() {
  return (
    <HashRouter>
      <div className="flex h-full">
        <Sidebar />
        <main className="flex-1 overflow-y-auto bg-[var(--color-surface)]">
          <Routes>
            <Route path="/" element={<Navigate to="/today" replace />} />
            <Route path="/today" element={<Today />} />
            <Route path="/focus" element={<Focus />} />
            <Route path="/history" element={<History />} />
            <Route path="/apps" element={<Apps />} />
            <Route path="/insights" element={<Insights />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  )
}
