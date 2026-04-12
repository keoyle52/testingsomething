import React from 'react';
import { useLocation } from 'react-router-dom';
import { useSettingsStore } from '../store/settingsStore';
import { Wifi, WifiOff, Globe } from 'lucide-react';

const PAGE_TITLES: Record<string, string> = {
  '/volume-bot': 'Volume Bot',
  '/grid-bot': 'Grid Bot',
  '/copy-trader': 'Copy Trader',
  '/positions': 'Position Monitor',
  '/funding': 'Funding Tracker',
  '/schedule-cancel': 'Schedule Cancel',
  '/settings': 'Settings',
};

export const Topbar: React.FC = () => {
  const location = useLocation();
  const title = PAGE_TITLES[location.pathname] ?? 'SoDEX Terminal';
  const { apiKeyName, isTestnet } = useSettingsStore();
  const isConnected = !!apiKeyName;

  return (
    <header className="h-[52px] border-b border-border bg-surface/50 backdrop-blur-xl flex items-center justify-between px-5 shrink-0">
      <div className="flex items-center gap-3">
        <h1 className="text-sm font-semibold text-text-primary">{title}</h1>
      </div>

      <div className="flex items-center gap-2">
        {/* Network Badge */}
        <div className={`badge ${isTestnet ? 'badge-neutral' : 'badge-primary'}`}>
          <Globe size={11} />
          {isTestnet ? 'Testnet' : 'Mainnet'}
        </div>

        {/* Separator */}
        <div className="w-px h-4 bg-border mx-1" />

        {/* Connection Status */}
        <div className={`badge ${isConnected ? 'badge-success' : 'badge-neutral'}`}>
          {isConnected ? (
            <>
              <Wifi size={11} />
              <span className="max-w-[100px] truncate">{apiKeyName}</span>
            </>
          ) : (
            <>
              <WifiOff size={11} />
              Not Connected
            </>
          )}
        </div>
      </div>
    </header>
  );
};
