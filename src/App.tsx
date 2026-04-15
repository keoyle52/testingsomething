import { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';

import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';

const Dashboard    = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })));
const GridBot      = lazy(() => import('./pages/GridBot').then(m => ({ default: m.GridBot })));
const TwapBot      = lazy(() => import('./pages/TwapBot').then(m => ({ default: m.TwapBot })));
const DcaBot       = lazy(() => import('./pages/DcaBot').then(m => ({ default: m.DcaBot })));
const CopyTrader   = lazy(() => import('./pages/CopyTrader').then(m => ({ default: m.CopyTrader })));
const Positions    = lazy(() => import('./pages/Positions').then(m => ({ default: m.Positions })));
const FundingTracker = lazy(() => import('./pages/FundingTracker').then(m => ({ default: m.FundingTracker })));
const ScheduleCancel = lazy(() => import('./pages/ScheduleCancel').then(m => ({ default: m.ScheduleCancel })));
const Alerts       = lazy(() => import('./pages/Alerts').then(m => ({ default: m.Alerts })));
const Backtesting  = lazy(() => import('./pages/Backtesting').then(m => ({ default: m.Backtesting })));
const Settings     = lazy(() => import('./pages/Settings').then(m => ({ default: m.Settings })));

const PageLoader = () => (
  <div className="flex-1 flex items-center justify-center">
    <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
  </div>
);

function App() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-text-primary font-sans antialiased">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Topbar />
        <main className="flex-1 overflow-x-hidden overflow-y-auto bg-background">
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/dashboard"       element={<Dashboard />} />
              <Route path="/grid-bot"        element={<GridBot />} />
              <Route path="/twap-bot"        element={<TwapBot />} />
              <Route path="/dca-bot"         element={<DcaBot />} />
              <Route path="/copy-trader"     element={<CopyTrader />} />
              <Route path="/positions"       element={<Positions />} />
              <Route path="/funding"         element={<FundingTracker />} />
              <Route path="/schedule-cancel" element={<ScheduleCancel />} />
              <Route path="/alerts"          element={<Alerts />} />
              <Route path="/backtesting"     element={<Backtesting />} />
              <Route path="/settings"        element={<Settings />} />
              <Route path="*"               element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </Suspense>
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
