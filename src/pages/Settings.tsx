import React, { useState, useMemo } from 'react';
import { useSettingsStore } from '../store/settingsStore';
import { perpsClient } from '../api/perpsClient';
import { wsService } from '../api/websocket';
import { clearServiceCaches } from '../api/services';
import { deriveAddressFromPrivateKey } from '../api/signer';
import toast from 'react-hot-toast';
import { ethers } from 'ethers';
import { Key, Shield, Settings2, Info, Wifi, Unplug, Globe, Bell, Hash, Zap, FlaskConical, Sun, Wallet } from 'lucide-react';
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
  const [testing, setTesting] = useState(false);

  // Derive the address that corresponds to the configured private key.
  // On testnet this IS the master wallet. On mainnet this is the agent /
  // API-key wallet, which is why we also expose a dedicated Master EVM
  // Address field below.
  const derivedAddress = useMemo(() => deriveAddressFromPrivateKey(store.privateKey), [store.privateKey]);

  // The address we will actually put in REST URL paths (balances / orders /
  // positions / state). Prefer the explicit `evmAddress`; fall back to the
  // derived address so testnet users still get a sensible default.
  const effectiveAddress = useMemo(() => {
    const explicit = (store.evmAddress ?? '').trim();
    if (explicit && ethers.isAddress(explicit)) return explicit;
    return derivedAddress;
  }, [store.evmAddress, derivedAddress]);

  const evmAddressLooksValid = !store.evmAddress || ethers.isAddress(store.evmAddress.trim());

  const handleTestConnection = async () => {
    if (!effectiveAddress) {
      toast.error('Enter a valid Private Key or Master EVM Address.');
      return;
    }
    setTesting(true);
    try {
      // Use the perps /state endpoint — it returns `aid` (accountID) and
      // validates that the address actually has a SoDEX account on the
      // current network. Public GETs are unsigned so we don't need a key.
      await perpsClient.get(`/accounts/${effectiveAddress}/state`);
      toast.success(`Connection successful (${store.isTestnet ? 'testnet' : 'mainnet'}).`);
    } catch (error: unknown) {
      const e = error as { response?: { data?: { error?: string; message?: string } } };
      const msg = e?.response?.data?.error
        ?? e?.response?.data?.message
        ?? (error instanceof Error ? error.message : 'Connection failed.');
      toast.error(msg);
    } finally {
      setTesting(false);
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
                    label={store.isTestnet ? 'API Key Name (Mainnet only — ignored on Testnet)' : 'API Key Name (X-API-Key)'}
                    type="text"
                    value={store.apiKeyName}
                    onChange={(e) => store.setApiKeyName(e.target.value)}
                    placeholder={store.isTestnet ? 'Not required on testnet' : 'Name chosen when creating the API key'}
                    icon={<Key size={14} />}
                    hint="Mainnet: the name (typically EVM address) of the SoDEX API key you registered — sent as `X-API-Key` on every signed request. Testnet: ignored; the derived address of the private key below is used instead."
                    disabled={store.isTestnet}
                  />

                  <Input
                    label={store.isTestnet ? 'Private Key (Master Wallet — Testnet)' : 'Private Key (API Key private key — NOT master wallet)'}
                    type="password"
                    value={store.privateKey}
                    onChange={(e) => store.setPrivateKey(e.target.value)}
                    placeholder="0x..."
                    hint={
                      store.isTestnet
                        ? 'Testnet: paste your master EVM wallet private key here — requests are signed with it directly. Stored only in memory, never persisted.'
                        : 'Mainnet: paste the API key\'s private key (from the keypair you were given when creating the API key), NOT your master wallet key. Stored only in memory, never persisted.'
                    }
                  />

                  <Input
                    label="Master EVM Address (used in REST URL paths)"
                    type="text"
                    value={store.evmAddress}
                    onChange={(e) => store.setEvmAddress(e.target.value)}
                    placeholder={store.isTestnet ? 'Optional — defaults to derived address' : '0x... (required on Mainnet)'}
                    icon={<Wallet size={14} />}
                    hint="Your master wallet address, the one connected to SoDEX. Used in URL paths like /accounts/{address}/state. On Testnet this defaults to the derived address. On Mainnet it MUST be set because the private key belongs to the API agent wallet, not the master."
                  />
                  {!evmAddressLooksValid && (
                    <p className="text-[10px] text-danger">Invalid EVM address format.</p>
                  )}

                  <div className="space-y-1.5">
                    <label className="block text-[11px] font-medium text-text-secondary uppercase tracking-wider">
                      Derived address (from private key)
                    </label>
                    <div className="w-full bg-background/60 border border-border rounded-lg px-3 py-2.5 text-sm text-text-muted font-mono truncate">
                      {derivedAddress || 'Will appear once a valid private key is entered...'}
                    </div>
                    {!store.isTestnet && derivedAddress && store.evmAddress && store.evmAddress.toLowerCase() !== derivedAddress.toLowerCase() && (
                      <p className="text-[10px] text-text-muted">
                        Mainnet: derived address (API agent) differs from master EVM address — this is expected.
                      </p>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-[11px] font-medium text-text-secondary uppercase tracking-wider">
                      Effective URL address (used in GETs)
                    </label>
                    <div className="w-full bg-background/60 border border-border rounded-lg px-3 py-2.5 text-sm text-text-primary font-mono truncate">
                      {effectiveAddress || '—'}
                    </div>
                  </div>
                </form>
              </Card>

              {/* SosoValue API */}
              <Card>
                <div className="flex items-center gap-2 mb-5">
                  <Hash size={16} className="text-primary" />
                  <div>
                    <h3 className="text-sm font-semibold">SosoValue API Key</h3>
                    <p className="text-[11px] text-text-muted mt-0.5">Required for ETF Tracker, Crypto News &amp; News Bot</p>
                  </div>
                </div>
                <Input
                  label="SosoValue API Key"
                  type="password"
                  value={store.sosoApiKey}
                  onChange={(e) => store.setSosoApiKey(e.target.value)}
                  placeholder="Enter your SosoValue API key..."
                  icon={<Key size={14} />}
                  hint="Get your key at sosovalue.com → API. Stored in localStorage."
                />
              </Card>

              {/* Gemini API */}
              <Card>
                <div className="flex items-center gap-2 mb-5">
                  <div className="w-4 h-4 rounded-full bg-gradient-to-tr from-blue-500 to-purple-500 overflow-hidden flex items-center justify-center">
                    <Zap size={10} className="text-white fill-white" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold">Gemini AI API Key</h3>
                    <p className="text-[11px] text-text-muted mt-0.5">Powering "News Bot" intelligent sentiment analysis</p>
                  </div>
                </div>
                <Input
                  label="Gemini API Key"
                  type="password"
                  value={store.geminiApiKey}
                  onChange={(e) => store.setGeminiApiKey(e.target.value)}
                  placeholder="Enter your Gemini API key..."
                  icon={<Zap size={14} />}
                  hint="Get your key at aistudio.google.com/app/apikey"
                />
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
                      clearServiceCaches();
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
                      clearServiceCaches();
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
                      Mainnet: real assets are used. Sign requests with your API key's private
                      key (not the master wallet key) and put your master wallet address in the
                      EVM Address field. Mainnet and Testnet account IDs are distinct.
                    </p>
                  </div>
                )}

                {store.isTestnet && (
                  <div className="mt-3 flex items-start gap-2 p-3 bg-primary/5 border border-primary/20 rounded-lg">
                    <Info size={14} className="text-primary shrink-0 mt-0.5" />
                    <p className="text-xs text-primary leading-relaxed">
                      Testnet mode: registered API keys do not work here. Sign with the master
                      wallet's private key; its derived address is used as the `X-API-Key`.
                      Mainnet and Testnet account IDs are different — make sure you are using
                      the right one for the network you are hitting.
                    </p>
                  </div>
                )}
              </Card>

              <div className="flex items-center gap-3 pt-2">
                <Button
                  variant="outline"
                  icon={<Wifi size={14} />}
                  onClick={handleTestConnection}
                  loading={testing}
                  disabled={testing || !effectiveAddress}
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

              <Card>
                <div className="flex items-center gap-2 mb-5">
                  <Sun size={16} className="text-primary" />
                  <h3 className="text-sm font-semibold">Appearance</h3>
                </div>
                <div className="space-y-3">
                  <Toggle
                    label="Light Theme"
                    description="Switch between dark and light color scheme"
                    checked={store.theme === 'light'}
                    onChange={(val) => store.setTheme(val ? 'light' : 'dark')}
                  />
                </div>
              </Card>

              <Card>
                <div className="flex items-center gap-2 mb-5">
                  <FlaskConical size={16} className="text-amber-400" />
                  <h3 className="text-sm font-semibold">Demo Mode</h3>
                </div>
                <div className="space-y-3">
                  <Toggle
                    label="Enable Demo Mode"
                    description="Explore the terminal with simulated data — no API key required"
                    checked={store.isDemoMode}
                    onChange={store.setIsDemoMode}
                  />
                  {store.isDemoMode && (
                    <div className="flex items-start gap-2 p-3 bg-amber-500/5 border border-amber-500/20 rounded-lg">
                      <FlaskConical size={14} className="text-amber-400 shrink-0 mt-0.5" />
                      <p className="text-xs text-amber-400 leading-relaxed">
                        Demo mode active. Prices fluctuate in real-time via simulation. No real orders will be placed.
                      </p>
                    </div>
                  )}
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
