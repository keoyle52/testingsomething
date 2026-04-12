import { Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';

import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';

import { VolumeBot } from './pages/VolumeBot';
import { GridBot } from './pages/GridBot';
import { CopyTrader } from './pages/CopyTrader';
import { Positions } from './pages/Positions';
import { FundingTracker } from './pages/FundingTracker';
import { ScheduleCancel } from './pages/ScheduleCancel';
import { Settings } from './pages/Settings';

function App() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-text-primary font-sans antialiased">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Topbar />
        <main className="flex-1 overflow-x-hidden overflow-y-auto bg-background">
          <Routes>
            <Route path="/volume-bot" element={<VolumeBot />} />
            <Route path="/grid-bot" element={<GridBot />} />
            <Route path="/copy-trader" element={<CopyTrader />} />
            <Route path="/positions" element={<Positions />} />
            <Route path="/funding" element={<FundingTracker />} />
            <Route path="/schedule-cancel" element={<ScheduleCancel />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/volume-bot" replace />} />
          </Routes>
        </main>
      </div>

      <Toaster
        position="bottom-right"
        toastOptions={{
          duration: 3000,
          style: {
            background: 'rgba(13,17,23,0.95)',
            color: '#e6edf3',
            border: '1px solid rgba(27,34,48,0.8)',
            backdropFilter: 'blur(12px)',
            borderRadius: '10px',
            fontSize: '13px',
            padding: '12px 16px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          },
          success: {
            iconTheme: { primary: '#3fb950', secondary: '#0d1117' },
          },
          error: {
            iconTheme: { primary: '#f85149', secondary: '#0d1117' },
          },
        }}
      />
    </div>
  );
}

export default App;
