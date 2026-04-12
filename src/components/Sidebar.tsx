import React from 'react';
import { NavLink } from 'react-router-dom';
import { Bot, Grid2X2, Users, LineChart, Coins, TimerOff, Settings, Zap } from 'lucide-react';
import { cn } from './common/NumberDisplay';

const NAV_ITEMS = [
  { to: '/volume-bot', icon: Bot, label: 'Volume Bot' },
  { to: '/grid-bot', icon: Grid2X2, label: 'Grid Bot' },
  { to: '/copy-trader', icon: Users, label: 'Copy Trader' },
  { to: '/positions', icon: LineChart, label: 'Positions' },
  { to: '/funding', icon: Coins, label: 'Funding' },
  { to: '/schedule-cancel', icon: TimerOff, label: 'Schedule' },
];

export const Sidebar: React.FC = () => {
  return (
    <aside className="w-[64px] border-r border-border bg-surface/50 backdrop-blur-xl flex flex-col items-center py-4 shrink-0">
      {/* Logo */}
      <div className="mb-6 flex items-center justify-center w-10 h-10 rounded-xl bg-primary/10 border border-primary/20">
        <Zap size={20} className="text-primary" />
      </div>

      {/* Nav Items */}
      <div className="flex-1 flex flex-col gap-1.5 w-full px-2">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                'relative flex items-center justify-center w-10 h-10 rounded-xl group transition-all duration-200',
                isActive
                  ? 'text-primary bg-primary/10 shadow-sm shadow-primary/10'
                  : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover',
              )
            }
            title={item.label}
          >
            {({ isActive }) => (
              <>
                {/* Active indicator bar */}
                {isActive && (
                  <div className="absolute -left-2 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-primary rounded-r-full" />
                )}
                <item.icon size={18} strokeWidth={isActive ? 2.2 : 1.8} />
                {/* Tooltip */}
                <div className="tooltip-content absolute left-14 opacity-0 invisible group-hover:opacity-100 group-hover:visible whitespace-nowrap z-50 transition-all duration-200 translate-x-1 group-hover:translate-x-0">
                  {item.label}
                </div>
              </>
            )}
          </NavLink>
        ))}
      </div>

      {/* Bottom Settings */}
      <div className="w-full px-2 pt-3 mt-auto">
        <div className="border-t border-border pt-3">
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              cn(
                'relative flex items-center justify-center w-10 h-10 rounded-xl group transition-all duration-200',
                isActive
                  ? 'text-primary bg-primary/10 shadow-sm shadow-primary/10'
                  : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover',
              )
            }
            title="Settings"
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <div className="absolute -left-2 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-primary rounded-r-full" />
                )}
                <Settings size={18} strokeWidth={isActive ? 2.2 : 1.8} />
                <div className="tooltip-content absolute left-14 opacity-0 invisible group-hover:opacity-100 group-hover:visible whitespace-nowrap z-50 transition-all duration-200 translate-x-1 group-hover:translate-x-0">
                  Settings
                </div>
              </>
            )}
          </NavLink>
        </div>
      </div>
    </aside>
  );
};
