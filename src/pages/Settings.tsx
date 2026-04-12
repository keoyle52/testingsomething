import React, { useState, useMemo } from 'react';
import { useSettingsStore } from '../store/settingsStore';
import { spotClient } from '../api/spotClient';
import toast from 'react-hot-toast';
import { ethers } from 'ethers';

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
      toast.error('Geçerli bir Private Key giriniz.');
      return;
    }
    try {
      // Dummy check according to instructions
      await spotClient.get(`/accounts/${evmAddress}/balances`);
      toast.success('Bağlantı başarılı!');
    } catch (error: any) {
      toast.error(error?.response?.data?.message || 'Bağlantı başarısız.');
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto h-full flex flex-col gap-6">
      <div className="flex items-center gap-1 border-b border-border">
        {(['api', 'preferences', 'about'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-primary text-text-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {tab === 'api' && 'API Bağlantısı'}
            {tab === 'preferences' && 'Tercihler'}
            {tab === 'about' && 'Hakkında'}
          </button>
        ))}
      </div>

      <div className="flex-1">
        {activeTab === 'api' && (
          <div className="space-y-6 max-w-lg">
            <div>
              <label className="block text-xs text-text-secondary mb-1">API Key Adı</label>
              <input
                type="text"
                value={store.apiKeyName}
                onChange={(e) => store.setApiKeyName(e.target.value)}
                className="w-full bg-surface border border-border rounded px-3 py-2 text-sm focus:border-primary outline-none"
                placeholder="Örn: test-key-1"
              />
            </div>
            
            <div>
              <label className="block text-xs text-text-secondary mb-1">Private Key (Local Only)</label>
              <input
                type="password"
                value={store.privateKey}
                onChange={(e) => store.setPrivateKey(e.target.value)}
                className="w-full bg-surface border border-border rounded px-3 py-2 text-sm focus:border-primary outline-none"
                placeholder="0x..."
              />
            </div>

            <div>
              <label className="block text-xs text-text-secondary mb-1">Türetilen EVM Adresi</label>
              <input
                type="text"
                value={evmAddress}
                readOnly
                className="w-full bg-surface border border-border rounded px-3 py-2 text-sm text-text-secondary outline-none opacity-70"
                placeholder="Private key girilince görünür..."
              />
            </div>

            <div>
              <label className="block text-xs text-text-secondary mb-1">Ağ</label>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => store.setIsTestnet(false)}
                  className={`flex-1 py-2 text-sm rounded border ${!store.isTestnet ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-surface text-text-secondary'}`}
                >
                  Mainnet
                </button>
                <button
                  onClick={() => store.setIsTestnet(true)}
                  className={`flex-1 py-2 text-sm rounded border ${store.isTestnet ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-surface text-text-secondary'}`}
                >
                  Testnet
                </button>
              </div>
            </div>

            <div className="flex items-center gap-3 pt-4 border-t border-border">
              <button
                onClick={handleTestConnection}
                className="px-4 py-2 bg-surface border border-border hover:border-primary text-sm rounded transition-colors"
              >
                Bağlantıyı Test Et
              </button>
              <button
                onClick={store.disconnect}
                className="px-4 py-2 bg-danger/10 text-danger border border-danger/30 hover:bg-danger/20 text-sm rounded transition-colors ml-auto"
              >
                Bağlantıyı Kes
              </button>
            </div>
          </div>
        )}

        {activeTab === 'preferences' && (
          <div className="space-y-6 max-w-lg">
            <div>
              <label className="block text-xs text-text-secondary mb-1">Varsayılan Sembol</label>
              <input
                type="text"
                value={store.defaultSymbol}
                onChange={(e) => store.setDefaultSymbol(e.target.value)}
                className="w-full bg-surface border border-border rounded px-3 py-2 text-sm"
              />
            </div>
            <div className="flex items-center justify-between p-3 bg-surface border border-border rounded">
              <span className="text-sm">Emir Onay Dialog'u</span>
              <button
                onClick={() => store.setConfirmOrders(!store.confirmOrders)}
                className={`w-10 h-5 rounded-full relative transition-colors ${store.confirmOrders ? 'bg-primary' : 'bg-border'}`}
              >
                <div className={`w-3 h-3 rounded-full bg-white absolute top-1 transition-all ${store.confirmOrders ? 'left-6' : 'left-1'}`} />
              </button>
            </div>
            <div className="flex items-center justify-between p-3 bg-surface border border-border rounded">
              <span className="text-sm">Toast Bildirimleri</span>
              <button
                onClick={() => store.setToastsEnabled(!store.toastsEnabled)}
                className={`w-10 h-5 rounded-full relative transition-colors ${store.toastsEnabled ? 'bg-primary' : 'bg-border'}`}
              >
                <div className={`w-3 h-3 rounded-full bg-white absolute top-1 transition-all ${store.toastsEnabled ? 'left-6' : 'left-1'}`} />
              </button>
            </div>
          </div>
        )}

        {activeTab === 'about' && (
          <div className="space-y-4">
            <h2 className="text-xl font-medium">SoDEX Toolset Terminal</h2>
            <p className="text-text-secondary text-sm">
              Bu uygulama SoDEX DEX üzerinde ileri düzey algoritmik işlemler (Grid Bot, Volume Bot)
              ve cüzdan yönetimi için tasarlanmış profesyonel bir araç takımıdır.
            </p>
            <div className="pt-4 mt-4 border-t border-border">
              <span className="text-xs text-text-secondary">v1.0.0</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
