import React from 'react';
import { NavLink } from 'react-router-dom';
import { 
  LayoutDashboard, Grid2X2, Clock, Repeat, Users, LineChart, Coins, 
  TimerOff, Bell, FlaskConical, Settings, Zap, BarChart2, Newspaper, Bot, Wrench, Brain
} from 'lucide-react';
import { cn } from '../lib/utils';

// We now group everything under 4 MAIN icons.
// Hovering over a main icon reveals the group's sub-pages.
const NAV_MENU = [
  {
    groupId: 'overview',
    icon: LayoutDashboard,
    label: 'Overview',
    items: [
      { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
      { to: '/positions', icon: LineChart, label: 'Positions' },
    ]
  },
  {
    groupId: 'algos',
    icon: Bot,
    label: 'Trade Bots',
    items: [
      { to: '/grid-bot', icon: Grid2X2, label: 'Grid Bot' },
      { to: '/twap-bot', icon: Clock, label: 'TWAP Bot' },
      { to: '/dca-bot', icon: Repeat, label: 'DCA Bot' },
      { to: '/news-bot', icon: Zap, label: 'News Bot' },
      { to: '/schedule-cancel', icon: TimerOff, label: 'Scheduler' },
    ]
  },
  {
    groupId: 'market',
    icon: BarChart2,
    label: 'Market Data',
    items: [
      { to: '/funding', icon: Coins, label: 'Funding Rates' },
      { to: '/etf-tracker', icon: BarChart2, label: 'ETF Tracker' },
      { to: '/news', icon: Newspaper, label: 'Crypto News' },
    ]
  },
  {
    groupId: 'tools',
    icon: Wrench,
    label: 'Pro Tools',
    items: [
      { to: '/copy-trader', icon: Users, label: 'Copy Trader' },
      { to: '/alerts', icon: Bell, label: 'Price Alerts' },
      { to: '/backtesting', icon: FlaskConical, label: 'Backtesting' },
    ]
  },
  {
    groupId: 'ai',
    icon: Brain,
    label: 'AI Tools',
    items: [
      { to: '/btc-predictor', icon: Brain, label: 'BTC Predictor' },
    ]
  }
];

export const Sidebar: React.FC = () => {
  const [mobileOpen, setMobileOpen] = React.useState(false);

  return (
    <>
      <button
        onClick={() => setMobileOpen(true)}
        className="md:hidden fixed top-3 left-3 z-50 w-10 h-10 rounded-xl bg-surface border border-border flex items-center justify-center text-text-muted hover:text-primary"
      >
        <Zap size={18} />
      </button>

      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/60 z-40 animate-backdrop"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Main ultra-minimal Sidebar */}
      <aside 
        className={cn(
          'border-r border-white/5 bg-[#0A0D14]/80 backdrop-blur-xl flex flex-col items-center py-6 shrink-0 z-50 transition-transform duration-300',
          'hidden md:flex md:w-[72px] md:relative md:translate-x-0',
          mobileOpen ? 'flex w-[72px] fixed inset-y-0 left-0 translate-x-0' : 'fixed inset-y-0 left-0 -translate-x-full',
        )}
      >
        
        <div className="mb-8 flex items-center justify-center w-11 h-11 rounded-xl bg-gradient-to-br from-primary to-blue-600 shadow-[0_0_15px_rgba(0,225,255,0.4)] relative cursor-pointer group">
          <Zap size={22} className="text-[#06090e] fill-[#06090e] group-hover:scale-110 transition-transform" />
          <div className="absolute left-[70px] bg-white/10 backdrop-blur-md border border-white/10 px-3 py-1.5 rounded-md text-xs font-bold text-white opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all">
            SoDEX
          </div>
        </div>

        {/* Just 4 Main Category Buttons */}
        <div className="flex-1 flex flex-col gap-4 w-full">
          {NAV_MENU.map((group) => (
            <div 
              key={group.groupId} 
              className="relative w-full flex justify-center group/parent px-3"
            >
              {/* Main Category Icon */}
              <div 
                className={cn(
                  'flex items-center justify-center w-11 h-11 rounded-xl cursor-default transition-all duration-300',
                  'text-text-secondary hover:text-primary hover:bg-primary/10 hover:shadow-[inset_0_0_12px_rgba(0,225,255,0.2)] hover:border hover:border-primary/20 group-hover/parent:text-primary group-hover/parent:bg-primary/10 group-hover/parent:shadow-[inset_0_0_12px_rgba(0,225,255,0.2)] group-hover/parent:border-primary/20'
                )}
              >
                <group.icon size={22} className="transition-transform duration-300 group-hover/parent:drop-shadow-[0_0_5px_rgba(0,225,255,0.8)] group-hover/parent:scale-110" />
              </div>

              {/* Advanced Flyout Menu for Sub-items, overlapping slightly to prevent hover gaps */}
              <div 
                className={cn(
                  "absolute left-[calc(100%-4px)] top-0 z-[60] pl-4 w-56 transition-all duration-200 origin-left",
                  "opacity-0 invisible scale-95 -translate-x-2 pointer-events-none",
                  "group-hover/parent:opacity-100 group-hover/parent:visible group-hover/parent:scale-100 group-hover/parent:translate-x-0 group-hover/parent:pointer-events-auto"
                )}
              >
                {/* 
                  The pl-2 above acts as the transparent bridge. 
                  By using absolute left-full (which is 100% of the parent width),
                  the flyout starts exactly where the sidebar button area ends.
                */}
                <div className="glass-panel rounded-xl overflow-hidden shadow-[0_8px_40px_rgba(0,0,0,0.7)] border border-white/20">
                  <div className="px-4 py-3 border-b border-white/10 bg-[#0A0D18]/90">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-[#00E1FF]">{group.label}</h3>
                  </div>
                  <div className="p-2 flex flex-col gap-1 bg-[#06090E]/95">
                    {group.items.map((item) => (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        onClick={() => setMobileOpen(false)}
                        className={({ isActive }) =>
                          cn(
                            'flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 group/link',
                            isActive 
                              ? 'bg-primary/20 text-primary shadow-[inset_0_0_10px_rgba(0,225,255,0.1)]' 
                              : 'text-text-secondary hover:bg-white/5 hover:text-text-primary'
                          )
                        }
                      >
                        {({ isActive }) => (
                          <>
                            <item.icon size={16} className={isActive ? "drop-shadow-[0_0_5px_rgba(0,225,255,0.8)]" : "opacity-70 group-hover/link:opacity-100"} />
                            <span className="text-sm font-medium tracking-wide">{item.label}</span>
                            {isActive && <div className="ml-auto w-1.5 h-1.5 rounded-full bg-primary shadow-[0_0_5px_var(--color-primary)]"></div>}
                          </>
                        )}
                      </NavLink>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Settings Button remains standalone at the bottom */}
        <div className="w-full px-3 pt-4 mt-auto shrink-0 mb-4">
          <div className="border-t border-white/10 pt-4 flex justify-center relative group/settings">
            <NavLink
              to="/settings"
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) =>
                cn(
                  'flex items-center justify-center w-11 h-11 rounded-xl transition-all duration-300 border border-transparent',
                  isActive
                    ? 'text-primary bg-primary/10 shadow-[inset_0_0_12px_rgba(0,225,255,0.2)] border-primary/20'
                    : 'text-text-secondary hover:text-text-primary hover:bg-white/5 hover:border-white/10'
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Settings size={22} className={cn("transition-transform duration-500 group-hover/settings:rotate-90", isActive && "drop-shadow-[0_0_5px_rgba(0,225,255,0.8)] scale-110")} />
                  {/* Standard Tooltip for Settings */}
                  <div className="absolute left-[64px] ml-2 px-3 py-1.5 glass-panel text-text-primary text-xs font-semibold tracking-wide rounded-lg opacity-0 invisible group-hover/settings:opacity-100 group-hover/settings:visible whitespace-nowrap z-50 transition-all duration-200 translate-x-2 group-hover/settings:translate-x-0 pointer-events-none">
                    System Settings
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
