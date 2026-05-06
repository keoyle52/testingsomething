---
description: Add a new SoDEX REST API endpoint to services.ts
---

## Steps to add a new API endpoint

1. **Check `sodexdocument/` for the API spec** — verify exact URL path, HTTP method, request body field ORDER (must match Go struct)

2. **Determine engine type**
   - Perpetuals (futures) → use `perpsClient`
   - Spot → use `spotClient`

3. **Add to `src/api/services.ts`**

   ### Read (GET) — unsigned
   ```ts
   export async function fetchSomething(params: ...) {
     if (isDemo()) return getDemoSomething(params);
     const { evmAddress, isTestnet } = useSettingsStore.getState();
     const address = getEvmAddress(evmAddress, isTestnet);
     const { data } = await perpsClient.get(`/accounts/${address}/something`);
     return data;
   }
   ```

   ### Write (POST/DELETE) — auto-signed by interceptor
   ```ts
   export async function doSomething(payload: SomethingPayload) {
     if (isDemo()) return demoDoSomething(payload);
     // Key order MUST match Go struct field order
     const body = {
       fieldA: payload.fieldA,
       fieldB: payload.fieldB,
     };
     const data = await perpsClient.post('/trade/something', body);
     assertNoBodyError(data, 'doSomething');
     return data;
   }
   ```

4. **Add demo stub** in `src/api/demoEngine.ts`
   - Export a `getDemoSomething` / `demoDoSomething` function
   - Import and re-export in the `demoEngine` import block at top of `services.ts`

5. **Update `deriveActionType`** in `src/api/signer.ts` if the new endpoint uses a new URL pattern

## Important rules
- Never call `perpsClient`/`spotClient` directly from a page — always go through `services.ts`
- Always check `isDemo()` before any network call
- Always call `assertNoBodyError(data, 'label')` after write calls
- JSON body key order = Go struct field order (server re-hashes for signature verification)
