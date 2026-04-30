import { Suspense, lazy, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';

import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { useSettingsStore } from './store/settingsStore';
// Settings loaded synchronously to avoid Suspense stall issues
import { Settings } from './pages/Settings';
import { startDemoEngine, stopDemoEngine } from './api/demoEngine';

/**
 * Lazy-loaded route modules. Each page is a separate chunk so the first
 * paint stays small; subsequent navigations warm the chunk via
 * `preloadCommonPages` on idle.
 */
type LazyImport = () => Promise<{ default: React.ComponentType }>;

const lazyFrom = (mod: LazyImport, key: string) => lazy(() => mod().then((m) => {
  // Guard against individual page chunks failing — show a tiny inline
  // fallback instead of an unstyled crash. In practice Vite's fetch-level
  // retries cover transient network blips first.
  return m as { default: React.ComponentType };
}).catch(() => ({
  default: () => (
    <div className="p-6 text-sm text-danger">
      Failed to load <code>{key}</code> chunk. Please reload the page.
    </div>
  ),
})));

const Dashboard    = lazyFrom(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })), 'Dashboard');
const GridBot      = lazyFrom(() => import('./pages/GridBot').then(m => ({ default: m.GridBot })), 'GridBot');
const TwapBot      = lazyFrom(() => import('./pages/TwapBot').then(m => ({ default: m.TwapBot })), 'TwapBot');
const DcaBot       = lazyFrom(() => import('./pages/DcaBot').then(m => ({ default: m.DcaBot })), 'DcaBot');
const CopyTrader   = lazyFrom(() => import('./pages/CopyTrader').then(m => ({ default: m.CopyTrader })), 'CopyTrader');
const Positions    = lazyFrom(() => import('./pages/Positions').then(m => ({ default: m.Positions })), 'Positions');
const FundingTracker = lazyFrom(() => import('./pages/FundingTracker').then(m => ({ default: m.FundingTracker })), 'FundingTracker');
const ScheduleCancel = lazyFrom(() => import('./pages/ScheduleCancel').then(m => ({ default: m.ScheduleCancel })), 'ScheduleCancel');
const Alerts       = lazyFrom(() => import('./pages/Alerts').then(m => ({ default: m.Alerts })), 'Alerts');
const Backtesting  = lazyFrom(() => import('./pages/Backtesting').then(m => ({ default: m.Backtesting })), 'Backtesting');
const EtfTracker   = lazyFrom(() => import('./pages/EtfTracker').then(m => ({ default: m.EtfTracker })), 'EtfTracker');
const NewsBot      = lazyFrom(() => import('./pages/NewsBot').then(m => ({ default: m.NewsBot })), 'NewsBot');
const BtcPredictor = lazyFrom(() => import('./pages/BtcPredictor').then(m => ({ default: m.BtcPredictor })), 'BtcPredictor');
const AiConsole    = lazyFrom(() => import('./pages/AiConsole').then(m => ({ default: m.AiConsole })),       'AiConsole');
const MacroCalendar  = lazyFrom(() => import('./pages/MacroCalendar').then(m => ({ default: m.MacroCalendar })),  'MacroCalendar');
const SsiIndices     = lazyFrom(() => import('./pages/SsiIndices').then(m => ({ default: m.SsiIndices })),       'SsiIndices');
const BtcTreasuries  = lazyFrom(() => import('./pages/BtcTreasuries').then(m => ({ default: m.BtcTreasuries })), 'BtcTreasuries');
const Fundraising    = lazyFrom(() => import('./pages/Fundraising').then(m => ({ default: m.Fundraising })),     'Fundraising');
const SectorSpotlight = lazyFrom(() => import('./pages/SectorSpotlight').then(m => ({ default: m.SectorSpotlight })), 'SectorSpotlight');
const CryptoStocks   = lazyFrom(() => import('./pages/CryptoStocks').then(m => ({ default: m.CryptoStocks })),   'CryptoStocks');

/**
 * Non-blocking Suspense fallback — a subtle top progress shimmer instead of
 * a full-screen spinner so the sidebar/topbar never collapse during a
 * route-chunk fetch.
 */
const PageLoader = () => (
  <div className="flex-1 relative">
    <div className="absolute top-0 left-0 right-0 h-[2px] overflow-hidden">
      <div
        className="h-full bg-gradient-to-r from-transparent via-primary to-transparent"
        style={{ animation: 'shimmer 1.2s linear infinite', backgroundSize: '200% 100%' }}
      />
    </div>
  </div>
);

/**
 * Keyed wrapper that re-mounts the active route's tree whenever the pathname
 * changes. The `key` prop resets previous-page React state (intervals,
 * subscriptions, stale fetch promises) and the `animate-fade-in` class adds
 * a short fade so the swap does not look jarring.
 */
function PageTransition({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  return (
    <div key={location.pathname} className="animate-fade-in h-full">
      {children}
    </div>
  );
}

/** Scroll the main container to top on every route change. */
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    const main = document.getElementById('app-main');
    if (main) main.scrollTo({ top: 0, behavior: 'auto' });
  }, [pathname]);
  return null;
}

/** Warm commonly-visited chunks on first idle so later nav is instant. */
function preloadCommonPages(): void {
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void) => void })
    .requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1200));
  idle(() => {
    void import('./pages/Positions');
    void import('./pages/GridBot');
    void import('./pages/FundingTracker');
  });
}

function App() {
  const { theme, isDemoMode } = useSettingsStore();

  // Apply theme class to root element
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('theme-light', theme === 'light');
    root.classList.toggle('theme-dark', theme === 'dark');
  }, [theme]);

  // Drive the demo engine lifecycle off the `isDemoMode` flag so every page
  // sees live-updating fake data without any per-page boilerplate.
  useEffect(() => {
    if (isDemoMode) {
      startDemoEngine();
      return () => stopDemoEngine();
    }
    return undefined;
  }, [isDemoMode]);

  // Warm a handful of common page chunks once the user is likely idle.
  useEffect(() => {
    preloadCommonPages();
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden text-text-primary font-sans antialiased bg-transparent selection:bg-primary/30">
      <ScrollToTop />
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden relative z-10 backdrop-blur-[2px]">
        <Topbar />
        <main id="app-main" className="flex-1 overflow-x-hidden overflow-y-auto p-4 md:p-6 lg:p-8">
          <PageTransition>
            <Routes>
              {/* Settings loaded outside Suspense to avoid load stalls */}
              <Route path="/settings" element={<Settings />} />
              <Route
                path="*"
                element={
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
                      <Route path="/etf-tracker"     element={<EtfTracker />} />
                      <Route path="/news-bot"        element={<NewsBot />} />
                      <Route path="/btc-predictor"   element={<BtcPredictor />} />
                      <Route path="/ai-console"      element={<AiConsole />} />
                      <Route path="/macro"           element={<MacroCalendar />} />
                      <Route path="/ssi-indices"     element={<SsiIndices />} />
                      <Route path="/btc-treasuries"  element={<BtcTreasuries />} />
                      <Route path="/fundraising"     element={<Fundraising />} />
                      <Route path="/sector-spotlight" element={<SectorSpotlight />} />
                      <Route path="/crypto-stocks"   element={<CryptoStocks />} />
                      <Route path="*"                element={<Navigate to="/dashboard" replace />} />
                    </Routes>
                  </Suspense>
                }
              />
            </Routes>
          </PageTransition>
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
