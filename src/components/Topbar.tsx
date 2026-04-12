import React from 'react';
import { useLocation } from 'react-router-dom';
import { useSettingsStore } from '../store/settingsStore';
import { Activity } from 'lucide-react';

const getTitle = (pathname: string) => {
  switch (pathname) {
    case '/volume-bot': return 'Volume Bot';
    case '/grid-bot': return 'Grid Bot';
    case '/copy-trader': return 'Copy Trader';
    case '/positions': return 'Position Monitor';
    case '/funding': return 'Funding Tracker';
    case '/schedule-cancel': return 'Schedule Cancel';
    case '/settings': return 'Settings';
    default: return 'SoDEX Terminal';
  }
};

export const Topbar: React.FC = () => {
  const location = useLocation();
  const title = getTitle(location.pathname);
  const { apiKeyName, isTestnet } = useSettingsStore();

  return (
    <header className="h-[48px] border-b border-border bg-surface flex items-center justify-between px-4 shrink-0">
      <h1 className="text-sm font-semibold">{title}</h1>
      
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-text-secondary">Network:</span>
          <span className={isTestnet ? 'text-text-primary' : 'text-primary'}>
            {isTestnet ? 'Testnet' : 'Mainnet'}
          </span>
        </div>
        
        <div className="w-px h-4 bg-border mx-1"></div>
        
        <div className="flex items-center gap-2 text-xs">
          <Activity size={14} className={apiKeyName ? 'text-success' : 'text-text-secondary'} />
          <span className={apiKeyName ? 'text-text-primary' : 'text-text-secondary'}>
            {apiKeyName ? apiKeyName : 'No API Key'}
          </span>
        </div>
      </div>
    </header>
  );
};
