import React from 'react';
import { NavLink } from 'react-router-dom';
import { 
  LayoutDashboard, Grid2X2, Clock, Repeat, Users, LineChart, Coins, 
  TimerOff, Bell, FlaskConical, Settings, Zap, BarChart2, Bot, Wrench, Brain,
  Sparkles, Newspaper, Calendar, Building, Banknote, Flame, Building2,
  MessageSquare, Layers,
} from 'lucide-react';
import { cn } from '../lib/utils';

// Five main nav groups. The 'ai' group is intentionally rendered first
// and given a distinct gradient/glow treatment so the BtcPredictor (the
// flagship feature) is the most visually prominent entry in the rail.
const NAV_MENU = [
  {
    groupId: 'ai',
    icon: Brain,
    label: 'AI Tools',
    items: [
      { to: '/ai-console',    icon: MessageSquare, label: 'AI Console'    },
      { to: '/btc-predictor', icon: Brain,         label: 'BTC Predictor' },
      { to: '/news-bot',      icon: Newspaper,     label: 'News Bot'      },
    ]
  },
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
      { to: '/grid-bot',        icon: Grid2X2,  label: 'Grid Bot' },
      { to: '/twap-bot',        icon: Clock,    label: 'TWAP Bot' },
      { to: '/dca-bot',         icon: Repeat,   label: 'DCA Bot' },
      { to: '/market-maker',    icon: Layers,   label: 'Market Maker' },
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
      { to: '/macro', icon: Calendar, label: 'Macro Calendar' },
    ]
  },
  // SoSoValue-powered analytical pages — purposely grouped together so the
  // jury can read them as a connected "intel suite" instead of being
  // sprinkled across the menu.
  {
    groupId: 'intel',
    icon: Sparkles,
    label: 'SoSoValue Intel',
    items: [
      { to: '/ssi-indices',     icon: Sparkles,  label: 'SSI Indices' },
      { to: '/btc-treasuries',  icon: Building2, label: 'BTC Treasuries' },
      { to: '/sector-spotlight',icon: Flame,     label: 'Sector Spotlight' },
      { to: '/fundraising',     icon: Banknote,  label: 'Fundraising' },
      { to: '/crypto-stocks',   icon: Building,  label: 'Crypto Stocks' },
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

        {/* Main category buttons. The 'ai' group renders with a distinct
            gradient/sparkle treatment so it reads as the headline tool. */}
        <div className="flex-1 flex flex-col gap-4 w-full">
          {NAV_MENU.map((group, idx) => (
            <React.Fragment key={group.groupId}>
              {/* Subtle separator between the AI hero entry and the rest of
                  the menu so the eye groups them as 'flagship vs. utilities'. */}
              {idx === 1 && (
                <div className="mx-auto w-7 border-t border-white/10 my-1" aria-hidden />
              )}
              <div 
                className="relative w-full flex justify-center group/parent px-3"
              >
                {/* Main Category Icon */}
                {group.groupId === 'ai' ? (
                  <div
                    className={cn(
                      'relative flex items-center justify-center w-11 h-11 rounded-xl cursor-default transition-all duration-300 overflow-hidden',
                      'bg-gradient-to-br from-violet-500/30 via-fuchsia-500/25 to-cyan-400/30',
                      'border border-fuchsia-400/40',
                      'shadow-[0_0_18px_rgba(217,70,239,0.45),inset_0_0_14px_rgba(168,85,247,0.30)]',
                      'animate-pulse',
                      'group-hover/parent:animate-none group-hover/parent:scale-[1.04]',
                      'group-hover/parent:shadow-[0_0_28px_rgba(217,70,239,0.75),inset_0_0_22px_rgba(168,85,247,0.45)]',
                      'group-hover/parent:border-fuchsia-300/70'
                    )}
                  >
                    {/* Animated diagonal sheen reusing the global `shimmer` keyframe */}
                    <span
                      aria-hidden
                      className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/15 to-transparent opacity-60 pointer-events-none"
                      style={{ animation: 'shimmer 2.6s linear infinite', backgroundSize: '200% 100%' }}
                    />
                    <group.icon
                      size={22}
                      className="relative text-fuchsia-100 drop-shadow-[0_0_8px_rgba(217,70,239,0.9)] transition-transform duration-300 group-hover/parent:scale-110"
                    />
                    {/* Tiny sparkle in the corner to read as 'AI / new' */}
                    <Sparkles
                      size={10}
                      className="absolute top-0.5 right-0.5 text-cyan-200 drop-shadow-[0_0_5px_rgba(0,225,255,0.9)] animate-pulse"
                    />
                  </div>
                ) : (
                  <div 
                    className={cn(
                      'flex items-center justify-center w-11 h-11 rounded-xl cursor-default transition-all duration-300',
                      'text-text-secondary hover:text-primary hover:bg-primary/10 hover:shadow-[inset_0_0_12px_rgba(0,225,255,0.2)] hover:border hover:border-primary/20 group-hover/parent:text-primary group-hover/parent:bg-primary/10 group-hover/parent:shadow-[inset_0_0_12px_rgba(0,225,255,0.2)] group-hover/parent:border-primary/20'
                    )}
                  >
                    <group.icon size={22} className="transition-transform duration-300 group-hover/parent:drop-shadow-[0_0_5px_rgba(0,225,255,0.8)] group-hover/parent:scale-110" />
                  </div>
                )}

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
                <div className={cn(
                  'glass-panel rounded-xl overflow-hidden shadow-[0_8px_40px_rgba(0,0,0,0.7)] border',
                  group.groupId === 'ai'
                    ? 'border-fuchsia-400/30 shadow-[0_8px_40px_rgba(217,70,239,0.25)]'
                    : 'border-white/20',
                )}>
                  <div className={cn(
                    'px-4 py-3 border-b border-white/10',
                    group.groupId === 'ai'
                      ? 'bg-gradient-to-r from-violet-500/15 via-fuchsia-500/10 to-cyan-400/15'
                      : 'bg-[#0A0D18]/90',
                  )}>
                    {group.groupId === 'ai' ? (
                      <h3 className="text-xs font-bold uppercase tracking-widest flex items-center gap-1.5 bg-gradient-to-r from-fuchsia-300 via-violet-300 to-cyan-300 bg-clip-text text-transparent">
                        <Sparkles size={10} className="text-fuchsia-300 shrink-0" />
                        {group.label}
                      </h3>
                    ) : (
                      <h3 className="text-xs font-bold uppercase tracking-widest text-[#00E1FF]">{group.label}</h3>
                    )}
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
            </React.Fragment>
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
