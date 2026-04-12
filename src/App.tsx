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
          style: {
            background: '#111111',
            color: '#ffffff',
            border: '1px solid #1e1e1e'
          }
        }} 
      />
    </div>
  );
}

export default App;
