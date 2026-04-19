import React from 'react';
import { useLocation, Link } from 'react-router-dom';
import { useSettingsStore } from '../store/settingsStore';
import { Wifi, WifiOff, Settings, Sun, Moon, FlaskConical } from 'lucide-react';

const PAGE_TITLES: Record<string, string> = {
  '/dashboard':       'Dashboard',
  '/grid-bot':        'Grid Bot',
  '/twap-bot':        'TWAP Bot',
  '/dca-bot':         'DCA Bot',
  '/news-bot':        'News Bot',
  '/copy-trader':     'Copy Trader',
  '/positions':       'Positions',
  '/funding':         'Funding Tracker',
  '/schedule-cancel': "Dead Man's Switch",
  '/alerts':          'Price Alerts',
  '/backtesting':     'Backtesting',
  '/etf-tracker':     'ETF Tracker',
  '/news':            'Crypto News',
  '/btc-predictor':   'BTC Price Predictor',
  '/settings':        'Settings',
};

export const Topbar: React.FC = () => {
  const location = useLocation();
  const title = PAGE_TITLES[location.pathname] ?? 'Terminal';
  const store = useSettingsStore();
  // A private key is the minimum required to sign requests. On mainnet a
  // separate master `evmAddress` is also needed for URL paths, but its
  // absence is surfaced as a more specific error inside Settings / API.
  const isConnected = !!store.privateKey;
  const isLight = store.theme === 'light';

  return (
    <header className="h-[72px] border-b border-white/5 bg-[#0A0D14]/50 backdrop-blur-md flex items-center justify-between px-6 shrink-0 z-40 theme-light:bg-white/60 theme-light:border-black/10">
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-bold tracking-wide text-text-primary drop-shadow-[0_0_8px_rgba(255,255,255,0.2)]">
          {title}
        </h1>
      </div>

      <div className="flex items-center gap-3">
        {/* Demo Mode Toggle */}
        <button
          onClick={() => store.setIsDemoMode(!store.isDemoMode)}
          title={store.isDemoMode ? 'Exit Demo Mode' : 'Enable Demo Mode'}
          className={cn(
            'flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-full border transition-all',
            store.isDemoMode
              ? 'bg-amber-500/15 border-amber-500/40 text-amber-400'
              : 'bg-white/5 border-white/10 text-text-muted hover:text-text-primary hover:border-white/20'
          )}
        >
          <FlaskConical size={13} />
          <span className="hidden sm:inline">{store.isDemoMode ? 'Demo' : 'Demo'}</span>
        </button>

        {/* Theme Toggle */}
        <button
          onClick={() => store.setTheme(isLight ? 'dark' : 'light')}
          title={isLight ? 'Switch to Dark' : 'Switch to Light'}
          className="flex items-center justify-center w-8 h-8 rounded-full bg-white/5 border border-white/10 text-text-muted hover:text-text-primary hover:bg-white/10 transition-all"
        >
          {isLight ? <Moon size={14} /> : <Sun size={14} />}
        </button>

        {/* Network Badge */}
        <div className="flex items-center gap-2 text-xs bg-white/5 border border-white/10 rounded-full px-3 py-1.5 shadow-[inset_0_0_10px_rgba(0,0,0,0.5)]">
          <div className={`w-2 h-2 rounded-full ${store.isTestnet ? 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]' : 'bg-primary shadow-[0_0_8px_var(--color-primary)]'}`} />
          <span className="text-text-primary font-medium tracking-wide">
            {store.isTestnet ? 'Testnet' : 'Mainnet'}
          </span>
        </div>

        {/* API Connection Status */}
        <div className="flex items-center gap-2 text-xs bg-white/5 border border-white/10 rounded-full px-3 py-1.5 cursor-default transition-all shadow-[inset_0_0_10px_rgba(0,0,0,0.5)]">
          {isConnected ? (
            <>
              <Wifi size={14} className="text-success drop-shadow-[0_0_5px_var(--color-success)]" />
              <span className="text-success font-medium tracking-wide">Online</span>
            </>
          ) : store.isDemoMode ? (
            <>
              <FlaskConical size={14} className="text-amber-400" />
              <span className="text-amber-400 font-medium tracking-wide">Demo</span>
            </>
          ) : (
            <>
              <WifiOff size={14} className="text-text-secondary" />
              <span className="text-text-secondary font-medium tracking-wide">Offline</span>
            </>
          )}
        </div>

        {/* Settings / API Key Button */}
        <Link 
          to="/settings"
          className={cn(
            "hidden md:flex items-center gap-2 text-sm font-semibold px-5 py-2 rounded-xl transition-all active:scale-95",
            !isConnected && !store.isDemoMode
              ? "bg-primary text-[#06090e] shadow-[0_0_15px_rgba(0,225,255,0.3)] hover:shadow-[0_0_20px_rgba(255,255,255,0.5)] hover:bg-white"
              : "bg-white/5 border border-white/10 text-text-primary hover:bg-white/10 shadow-[inset_0_0_10px_rgba(0,0,0,0.5)]"
          )}
        >
          <Settings size={16} className={isConnected ? "text-primary drop-shadow-[0_0_5px_var(--color-primary)]" : ""} />
          <span>{isConnected ? 'Settings' : 'Enter API Key'}</span>
        </Link>
      </div>
    </header>
  );
};

function cn(...classes: string[]) {
  return classes.filter(Boolean).join(' ');
}
