import React from 'react';
import { NavLink } from 'react-router-dom';
import { Bot, Grid2X2, Users, LineChart, Coins, TimerOff, Settings } from 'lucide-react';
import { cn } from './common/NumberDisplay';

const NAV_ITEMS = [
  { to: '/volume-bot', icon: Bot, label: 'Volume Bot' },
  { to: '/grid-bot', icon: Grid2X2, label: 'Grid Bot' },
  { to: '/copy-trader', icon: Users, label: 'Copy Trader' },
  { to: '/positions', icon: LineChart, label: 'Position Monitor' },
  { to: '/funding', icon: Coins, label: 'Funding Tracker' },
  { to: '/schedule-cancel', icon: TimerOff, label: 'Schedule Cancel' },
];

export const Sidebar: React.FC = () => {
  return (
    <aside className="w-[56px] border-r border-border bg-surface flex flex-col items-center py-4 shrink-0">
      <div className="flex-1 flex flex-col gap-4 w-full px-2">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                'relative flex items-center justify-center w-10 h-10 rounded-md group hover:bg-border/50 text-text-secondary transition-colors',
                isActive && 'text-primary bg-primary/10 hover:bg-primary/20'
              )
            }
            title={item.label}
          >
            <item.icon size={20} />
            <div className="absolute left-14 px-2 py-1 bg-surface border border-border text-xs rounded opacity-0 invisible group-hover:opacity-100 group-hover:visible whitespace-nowrap z-50 transition-all">
              {item.label}
            </div>
          </NavLink>
        ))}
      </div>
      
      <div className="w-full px-2 pt-4 border-t border-border mt-auto">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            cn(
              'relative flex items-center justify-center w-10 h-10 rounded-md group hover:bg-border/50 text-text-secondary transition-colors',
              isActive && 'text-primary bg-primary/10 hover:bg-primary/20'
            )
          }
          title="Settings"
        >
          <Settings size={20} />
          <div className="absolute left-14 px-2 py-1 bg-surface border border-border text-xs rounded opacity-0 invisible group-hover:opacity-100 group-hover:visible whitespace-nowrap z-50 transition-all">
            Settings
          </div>
        </NavLink>
      </div>
    </aside>
  );
};
