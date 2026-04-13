import React from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Bot, Grid2X2, Clock, Repeat, Users, LineChart, Coins, TimerOff, Bell, FlaskConical, Settings, Zap } from 'lucide-react';
import { cn } from '../lib/utils';

const NAV_ITEMS = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/volume-bot', icon: Bot, label: 'Volume Bot' },
  { to: '/grid-bot', icon: Grid2X2, label: 'Grid Bot' },
  { to: '/twap-bot', icon: Clock, label: 'TWAP Bot' },
  { to: '/dca-bot', icon: Repeat, label: 'DCA Bot' },
  { to: '/copy-trader', icon: Users, label: 'Copy Trader' },
  { to: '/positions', icon: LineChart, label: 'Positions' },
  { to: '/funding', icon: Coins, label: 'Funding' },
  { to: '/schedule-cancel', icon: TimerOff, label: 'Schedule' },
  { to: '/alerts', icon: Bell, label: 'Alerts' },
  { to: '/backtesting', icon: FlaskConical, label: 'Backtest' },
];

export const Sidebar: React.FC = () => {
  const [mobileOpen, setMobileOpen] = React.useState(false);

  return (
    <>
      {/* Mobile hamburger */}
      <button
        onClick={() => setMobileOpen(true)}
        className="md:hidden fixed top-3 left-3 z-50 w-10 h-10 rounded-xl bg-surface border border-border flex items-center justify-center text-text-muted hover:text-primary"
        aria-label="Open menu"
      >
        <Zap size={18} />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/60 z-40 animate-backdrop"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={cn(
        'border-r border-border bg-surface/50 backdrop-blur-xl flex flex-col items-center py-4 shrink-0 z-50 transition-transform duration-300',
        // Desktop: always visible
        'hidden md:flex md:w-[64px] md:relative md:translate-x-0',
        // Mobile: slide in/out
        mobileOpen ? 'flex w-[64px] fixed inset-y-0 left-0 translate-x-0' : 'fixed inset-y-0 left-0 -translate-x-full',
      )}>
      {/* Logo */}
      <div className="mb-6 flex items-center justify-center w-10 h-10 rounded-xl bg-primary/10 border border-primary/20">
        <Zap size={20} className="text-primary" />
      </div>

      {/* Nav Items - scrollable */}
      <div className="flex-1 flex flex-col gap-1 w-full px-2 overflow-y-auto scrollbar-thin">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={() => setMobileOpen(false)}
            className={({ isActive }) =>
              cn(
                'relative flex items-center justify-center w-10 h-10 rounded-xl group transition-all duration-200 shrink-0',
                isActive
                  ? 'text-primary bg-primary/10 shadow-sm shadow-primary/10'
                  : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover',
              )
            }
            title={item.label}
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <div className="absolute -left-2 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-primary rounded-r-full" />
                )}
                <item.icon size={18} strokeWidth={isActive ? 2.2 : 1.8} />
                <div className="tooltip-content absolute left-14 opacity-0 invisible group-hover:opacity-100 group-hover:visible whitespace-nowrap z-50 transition-all duration-200 translate-x-1 group-hover:translate-x-0">
                  {item.label}
                </div>
              </>
            )}
          </NavLink>
        ))}
      </div>

      {/* Bottom Settings */}
      <div className="w-full px-2 pt-3 mt-auto shrink-0">
        <div className="border-t border-border pt-3">
          <NavLink
            to="/settings"
            onClick={() => setMobileOpen(false)}
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
    </>
  );
};
