import { placeOrder } from './api/services.js';
import { useSettingsStore } from './store/settingsStore.js';

const KEY2 = '0x95cc77cfcee7cf785def506d54d483fb0ccdd99634fbd205cb5214b7d87bd0cb';

async function runTest() {
  console.log(`\nTesting key: ${KEY2}`);
  useSettingsStore.setState({
    apiKeyName: '',
    privateKey: KEY2,
    isTestnet: true
  });
  
  try {
     const res = await placeOrder({
       symbol: 'BTC-USD',
       side: 1, // BUY
       type: 2, // MARKET
       quantity: '0.001',
       timeInForce: 3 // IOC
     }, 'perps');
     console.log('Perps Order PLACED!', res);
  } catch (e: any) {
     console.error('Perps Error:', e.message || e);
     if (e.response?.config?.data) {
        console.error('Payload Sent:', e.response.config.data);
     }
  }
}

runTest();
