import { perpsClient } from './api/perpsClient.js';
import { useSettingsStore } from './store/settingsStore.js';

const KEY2 = '0x95cc77cfcee7cf785def506d54d483fb0ccdd99634fbd205cb5214b7d87bd0cb';

async function runTest() {
  console.log(`\nTesting manual HTTP POST`);
  useSettingsStore.setState({
    apiKeyName: '',
    privateKey: KEY2,
    isTestnet: true
  });
  
  try {
     const payload = {
        accountId: 46502,
        symbolId: 1,
        orders: [{
            clOrdID: "mo3932r7-test1",
            modifier: 1,
            side: 1,
            type: 2, // MARKET
            timeInForce: 3, // IOC
            quantity: "0.001",
            reduceOnly: false,
            positionSide: 1
        }]
     };
     // Try accountID first
     try {
       await perpsClient.post('/trade/orders', { ...payload, accountID: 46502, symbolID: 1 });
     } catch (e: any) {
       console.log('With accountID / symbolID:', e.message);
     }
     
     // Try accountId
     try {
       await perpsClient.post('/trade/orders', { ...payload, accountId: 46502, symbolId: 1 });
     } catch (e: any) {
       console.log('With accountId / symbolId:', e.message);
     }
  } catch (e: any) {
     console.error('Fatal:', e);
  }
}

runTest();
