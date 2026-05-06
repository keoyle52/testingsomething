---
description: Add a new trading bot page to SoDEX Terminal
---

## Steps to add a new trading bot page

1. **Add bot state to `src/store/botStore.ts`**
   - Define an interface: `interface MyBotState { ... }`
   - Include: config fields (strings), status (`'STOPPED' | 'RUNNING' | 'ERROR'`), stat fields (numbers), `setField`, `bumpField` (if accumulating), `resetStats`
   - Add to `BotStoreState` interface and initialise in `create()`

2. **Create `src/pages/MyBot.tsx`**
   - Import pattern:
     ```tsx
     import { useBotStore } from '../store/botStore';
     import { useSettingsStore } from '../store/settingsStore';
     import { useBotPnlStore } from '../store/botPnlStore';
     import { Card, StatCard } from '../components/common/Card';
     import { Input } from '../components/common/Input';
     import { Button } from '../components/common/Button';
     import { StatusBadge } from '../components/common/StatusBadge';
     import { BotPnlStrip } from '../components/common/BotPnlStrip';
     import { AutoConfigureButton } from '../components/common/AutoConfigureButton';
     import { cn, getErrorMessage } from '../lib/utils';
     import toast from 'react-hot-toast';
     ```
   - Bot loop: `const intervalRef = useRef<number | null>(null)`
   - Always clear interval + cancel open orders on Stop
   - Use `bumpField` (NOT `setField('x', x + delta)`) for accumulating stats

3. **Add AI auto-configure** in `src/api/aiAutoConfig.ts`
   - Export `recommendMyBot(ctx: MarketContext, currentConfig: ...): Partial<...>`
   - Conservative defaults only — no high leverage, no oversized positions

4. **Register route** — follow `add-new-page.md` workflow

5. **Sidebar section**: Add under "Trade Bots" section in `Sidebar.tsx`

## Bot loop pattern
```tsx
const tickRef = useCallback(async () => {
  const mm = useBotStore.getState().myBot;
  if (mm.status !== 'RUNNING') return;
  try {
    // ... do work ...
    mm.bumpField('volumeUsdt', fill.qty * fill.price);
  } catch (err) {
    mm.setField('status', 'ERROR');
    toast.error(getErrorMessage(err));
    if (intervalRef.current) clearInterval(intervalRef.current);
  }
}, []);

const handleStart = useCallback(() => {
  myBot.setField('status', 'RUNNING');
  intervalRef.current = window.setInterval(tickRef, intervalMs);
}, [tickRef, intervalMs]);

const handleStop = useCallback(async () => {
  if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
  myBot.setField('status', 'STOPPED');
  // cancel open orders here
}, []);

useEffect(() => () => { if (intervalRef.current) clearInterval(intervalRef.current); }, []);
```
