import { Suspense, lazy, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';

import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { useSettingsStore } from './store/settingsStore';
import { wsService } from './api/websocket';

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
const EtfTracker   = lazy(() => import('./pages/EtfTracker').then(m => ({ default: m.EtfTracker })));
const CryptoNews   = lazy(() => import('./pages/CryptoNews').then(m => ({ default: m.CryptoNews })));
const NewsBot      = lazy(() => import('./pages/NewsBot').then(m => ({ default: m.NewsBot })));

const PageLoader = () => (
  <div className="flex-1 flex items-center justify-center">
    <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
  </div>
);

function App() {
  const { theme, isTestnet, isDemoMode } = useSettingsStore();

  // Apply theme class to root element
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('theme-light', theme === 'light');
    root.classList.toggle('theme-dark', theme === 'dark');
  }, [theme]);

  // Boot WebSocket connection (non-demo mode only)
  useEffect(() => {
    if (!isDemoMode) {
      wsService.connect(isTestnet);
    } else {
      wsService.disconnect();
    }
  }, [isTestnet, isDemoMode]);

  return (
    <div className="flex h-screen w-screen overflow-hidden text-text-primary font-sans antialiased bg-transparent selection:bg-primary/30">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden relative z-10 backdrop-blur-[2px]">
        <Topbar />
        <main className="flex-1 overflow-x-hidden overflow-y-auto p-4 md:p-6 lg:p-8">
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
              <Route path="/etf-tracker"     element={<EtfTracker />} />
              <Route path="/news"            element={<CryptoNews />} />
              <Route path="/news-bot"        element={<NewsBot />} />
              <Route path="*"               element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </Suspense>
        </main>
      </div>

      <Toaster
        position="bottom-right"
        toastOptions={{
          duration: 3500,
          style: {
            background: 'rgba(14, 20, 29, 0.95)',
            color: '#f0f4f8',
            border: '1px solid rgba(0, 225, 255, 0.2)',
            backdropFilter: 'blur(12px)',
            borderRadius: '12px',
            fontSize: '13px',
            padding: '12px 16px',
            boxShadow: '0 8px 32px rgba(0, 225, 255, 0.1)',
          },
          success: {
            iconTheme: { primary: '#00e676', secondary: '#06090e' },
          },
          error: {
            iconTheme: { primary: '#ff3366', secondary: '#06090e' },
          },
        }}
      />
    </div>
  );
}

export default App;
