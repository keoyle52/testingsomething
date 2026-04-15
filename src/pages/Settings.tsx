import React, { useState, useMemo } from 'react';
import { useSettingsStore } from '../store/settingsStore';
import { spotClient } from '../api/spotClient';
import { wsService } from '../api/websocket';
import toast from 'react-hot-toast';
import { ethers } from 'ethers';
import { Key, Shield, Settings2, Info, Wifi, Unplug, Globe, Bell, Hash } from 'lucide-react';
import { Card } from '../components/common/Card';
import { Input } from '../components/common/Input';
import { Toggle } from '../components/common/Input';
import { Button } from '../components/common/Button';
import { cn } from '../lib/utils';

const TABS = [
  { id: 'api' as const, label: 'API Connection', icon: Key },
  { id: 'preferences' as const, label: 'Preferences', icon: Settings2 },
  { id: 'about' as const, label: 'About', icon: Info },
];

export const Settings: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'api' | 'preferences' | 'about'>('api');
  const store = useSettingsStore();

  const evmAddress = useMemo(() => {
    try {
      if (store.privateKey && store.privateKey.length >= 64) {
        let pk = store.privateKey;
        if (!pk.startsWith('0x')) pk = '0x' + pk;
        const wallet = new ethers.Wallet(pk);
        return wallet.address;
      }
    } catch {
      return '';
    }
    return '';
  }, [store.privateKey]);

  const handleTestConnection = async () => {
    if (!evmAddress) {
      toast.error('Enter a valid Private Key.');
      return;
    }
    try {
      await spotClient.get(`/accounts/${evmAddress}/balances`);
      toast.success('Connection successful!');
    } catch (error: unknown) {
      const e = error as { response?: { data?: { message?: string } } };
      toast.error(e?.response?.data?.message || 'Connection failed.');
    }
  };

  return (
    <div className="p-6 h-[calc(100vh-52px)] overflow-y-auto">
      <div className="max-w-3xl mx-auto flex flex-col gap-6">
        {/* Tabs */}
        <div className="flex gap-1 p-1 bg-surface/50 border border-border rounded-xl w-fit">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex items-center gap-2 px-4 py-2.5 text-xs font-medium rounded-lg transition-all duration-200',
                activeTab === tab.id
                  ? 'bg-primary/10 text-primary shadow-sm'
                  : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover',
              )}
            >
              <tab.icon size={14} />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="animate-fade-in">
          {activeTab === 'api' && (
            <div className="space-y-5 max-w-xl">
              <Card>
                <div className="flex items-center gap-2 mb-5">
                  <Shield size={16} className="text-primary" />
                  <h3 className="text-sm font-semibold">API Configuration</h3>
                </div>

                <form onSubmit={(e) => e.preventDefault()} className="space-y-4">
                  <Input
                    label="API Key Name"
                    type="text"
                    value={store.apiKeyName}
                    onChange={(e) => store.setApiKeyName(e.target.value)}
                    placeholder="e.g. test-key-1"
                    icon={<Key size={14} />}
                  />

                  <Input
                    label="Private Key (Local Only)"
                    type="password"
                    value={store.privateKey}
                    onChange={(e) => store.setPrivateKey(e.target.value)}
                    placeholder="0x..."
                    hint="Your key is stored only in your browser and never sent to any server."
                  />

                  <div className="space-y-1.5">
                    <label className="block text-[11px] font-medium text-text-secondary uppercase tracking-wider">
                      Derived EVM Address
                    </label>
                    <div className="w-full bg-background/60 border border-border rounded-lg px-3 py-2.5 text-sm text-text-muted font-mono truncate">
                      {evmAddress || 'Will appear once a valid private key is entered...'}
                    </div>
                  </div>
                </form>
              </Card>

              <Card>
                <div className="flex items-center gap-2 mb-5">
                  <Globe size={16} className="text-primary" />
                  <h3 className="text-sm font-semibold">Network</h3>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      store.setIsTestnet(false);
                      wsService.switchNetwork(false);
                    }}
                    className={`flex-1 py-3 text-sm rounded-lg border transition-all duration-200 font-medium ${
                      !store.isTestnet
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-background/40 text-text-muted hover:border-border-hover'
                    }`}
                  >
                    Mainnet
                  </button>
                  <button
                    onClick={() => {
                      store.setIsTestnet(true);
                      wsService.switchNetwork(true);
                    }}
                    className={`flex-1 py-3 text-sm rounded-lg border transition-all duration-200 font-medium ${
                      store.isTestnet
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-background/40 text-text-muted hover:border-border-hover'
                    }`}
                  >
                    Testnet
                  </button>
                </div>

                {!store.isTestnet && (
                  <div className="mt-3 flex items-start gap-2 p-3 bg-warning/5 border border-warning/20 rounded-lg">
                    <Info size={14} className="text-warning shrink-0 mt-0.5" />
                    <p className="text-xs text-warning leading-relaxed">
                      You are in Mainnet mode. Real assets will be used in transactions.
                    </p>
                  </div>
                )}
              </Card>

              <div className="flex items-center gap-3 pt-2">
                <Button
                  variant="outline"
                  icon={<Wifi size={14} />}
                  onClick={handleTestConnection}
                >
                  Test Connection
                </Button>
                <Button
                  variant="danger"
                  icon={<Unplug size={14} />}
                  onClick={store.disconnect}
                  className="ml-auto"
                >
                  Disconnect
                </Button>
              </div>
            </div>
          )}

          {activeTab === 'preferences' && (
            <div className="space-y-5 max-w-xl">
              <Card>
                <div className="flex items-center gap-2 mb-5">
                  <Hash size={16} className="text-primary" />
                  <h3 className="text-sm font-semibold">Defaults</h3>
                </div>
                <Input
                  label="Default Symbol"
                  type="text"
                  value={store.defaultSymbol}
                  onChange={(e) => store.setDefaultSymbol(e.target.value)}
                  placeholder="BTC-USD"
                />
              </Card>

              <Card>
                <div className="flex items-center gap-2 mb-5">
                  <Bell size={16} className="text-primary" />
                  <h3 className="text-sm font-semibold">Notifications & Confirmations</h3>
                </div>
                <div className="space-y-3">
                  <Toggle
                    label="Order Confirmation Dialog"
                    description="Show confirmation modal before placing orders"
                    checked={store.confirmOrders}
                    onChange={store.setConfirmOrders}
                  />
                  <Toggle
                    label="Toast Notifications"
                    description="Show order results as toast notifications"
                    checked={store.toastsEnabled}
                    onChange={store.setToastsEnabled}
                  />
                </div>
              </Card>
            </div>
          )}

          {activeTab === 'about' && (
            <div className="max-w-xl">
              <Card>
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                    <Info size={22} className="text-primary" />
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold gradient-text inline-block">SoDEX Toolset Terminal</h2>
                    <p className="text-sm text-text-secondary mt-2 leading-relaxed">
                      A professional-grade toolset for advanced algorithmic trading on SoDEX DEX,
                      featuring Grid Bot, TWAP Bot, DCA Bot, Copy Trading, and portfolio monitoring.
                    </p>
                    <div className="mt-4 pt-4 border-t border-border">
                      <div className="badge badge-primary">v1.0.0</div>
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
