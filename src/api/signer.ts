import { ethers } from 'ethers';

/**
 * SoDEX REST v1 signing helpers.
 *
 * The server verifies every signed write request by:
 *  1. Parsing the JSON body into a Go struct.
 *  2. Wrapping it in `ActionPayload{ type, params }` and re-serialising via
 *     `json.Marshal`, which emits fields in Go struct declaration order.
 *  3. Computing `payloadHash = keccak256(<that JSON>)`.
 *  4. Verifying `EIP-712` signature over `ExchangeAction{ payloadHash, nonce }`
 *     using the engine-specific domain (name "spot" or "futures").
 *
 * See:
 *  - `sodexdocument/api.md` (Typed signature)
 *  - `sodexdocument/sodex-go-sdk-public-main/common/types/eip712.go`
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const CHAIN_ID_MAINNET = 286623;
const CHAIN_ID_TESTNET = 138565;

export type DomainType = 'spot' | 'futures';

/**
 * EIP-712 domain for a given engine + network. Matches the Go SDK's
 * `NewEIP712Domain` helper.
 */
export const getDomain = (type: DomainType, isTestnet = false) => ({
  name: type,
  version: '1',
  chainId: isTestnet ? CHAIN_ID_TESTNET : CHAIN_ID_MAINNET,
  verifyingContract: ZERO_ADDRESS,
});

/**
 * Single generic EIP-712 type used by every signed action — the actual
 * action content is compressed into `payloadHash` (see `signPayload`).
 */
export const EIP712_TYPES = {
  ExchangeAction: [
    { name: 'payloadHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint64' },
  ],
};

/**
 * Normalise a user-supplied hex string private key to `0x`-prefixed form.
 * Trims whitespace to defend against accidental paste errors.
 */
export function normalizePrivateKey(pk: string): string {
  const trimmed = (pk ?? '').trim();
  if (!trimmed) return '';
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}

/**
 * Derive the EVM address corresponding to a private key.
 * Returns an empty string for invalid input so callers can display
 * validation errors without throwing.
 */
export function deriveAddressFromPrivateKey(pk: string): string {
  const normalised = normalizePrivateKey(pk);
  if (!normalised) return '';
  try {
    return new ethers.Wallet(normalised).address;
  } catch {
    return '';
  }
}

/**
 * Per-API-key monotonic nonce generator.
 *
 * SoDEX tracks nonces **per API key** (the 100 highest nonces are kept in
 * a rolling set; see `api.md` → "Sodex nonces"). If the same signing
 * identity issues two requests with the same nonce the second one is
 * rejected. When multiple accounts share a browser tab they must still
 * produce strictly increasing nonces — hence a single global atomic
 * counter keyed by the effective API key (= agent address or wallet
 * address), initialised from the current wall-clock millisecond.
 *
 * Nonces must also fall within `(T - 2 days, T + 1 day)`, which is
 * easily satisfied by seeding from `Date.now()`.
 */
const _nonceMap = new Map<string, bigint>();

/**
 * Return a strictly increasing nonce for the given API key.
 */
export function getMonotonicNonce(apiKey?: string): string {
  const key = (apiKey ?? '__default__').toLowerCase();
  const now = BigInt(Date.now());
  const last = _nonceMap.get(key) ?? 0n;
  const next = now > last ? now : last + 1n;
  _nonceMap.set(key, next);
  return next.toString();
}

/**
 * Derive the SoDEX action `type` string from an HTTP method and URL path.
 * These values match the constants defined in the Go SDK
 * (`*RequestTypeName`), which the exchange uses as the `type` tag when
 * re-hashing the payload server-side.
 *
 * IMPORTANT: the `/trade/orders/batch` (spot) prefix MUST be checked
 * **before** the plain `/trade/orders` (perps) prefix because
 * `String.includes` would otherwise match both.
 */
export function deriveActionType(method: string, url: string): string {
  const m = method.toUpperCase();
  if (url.includes('/trade/orders/schedule-cancel')) return 'scheduleCancel';
  if (url.includes('/trade/orders/replace')) return 'replaceOrder';
  if (url.includes('/trade/orders/modify')) return 'modifyOrder';
  if (url.includes('/trade/orders/batch')) {
    return m === 'DELETE' ? 'batchCancelOrder' : 'batchNewOrder';
  }
  if (url.includes('/trade/orders') && m === 'DELETE') return 'cancelOrder';
  if (url.includes('/trade/orders')) return 'newOrder';
  if (url.includes('/accounts/transfers')) return 'transferAsset';
  if (url.includes('/trade/leverage')) return 'updateLeverage';
  if (url.includes('/trade/margin')) return 'updateMargin';
  return 'action';
}

/**
 * Sign a SoDEX write request using EIP-712.
 *
 * Pipeline (mirrors `common/signer/evm_signer.go` → `SignAction`):
 *  1. Wrap `payload` in `{ type: actionType, params: payload }`.
 *  2. `payloadHash = keccak256(JSON.stringify(envelope))`.
 *      `JSON.stringify` preserves object insertion order, so callers
 *      MUST build `payload` with keys in Go struct declaration order.
 *  3. Sign `ExchangeAction{ payloadHash, nonce }` with the engine domain.
 *  4. Prepend type-prefix byte `0x01` (SignatureTypeEIP712) to the
 *     raw 65-byte ECDSA signature → 66-byte wire signature.
 *
 * @returns hex signature (with `0x01` prefix) and the nonce used.
 */
export async function signPayload(
  actionType: string,
  payload: Record<string, unknown>,
  privateKey: string,
  type: DomainType,
  isTestnet: boolean,
  apiKey?: string,
): Promise<{ signature: string; nonce: string }> {
  const normalisedPk = normalizePrivateKey(privateKey);
  if (!normalisedPk) throw new Error('Private key is required to sign requests');
  const wallet = new ethers.Wallet(normalisedPk);
  // Use apiKey (or wallet address) for per-key nonce isolation so that
  // multiple identities in the same browser tab never collide.
  const nonce = getMonotonicNonce(apiKey ?? wallet.address);

  // Wrap in the {type, params} envelope required by SoDEX before hashing.
  // JSON.stringify without replacer/indent preserves insertion order of
  // object keys, which must match the Go struct field order.
  const signingPayload = { type: actionType, params: payload ?? {} };
  const payloadString = JSON.stringify(signingPayload);
  const payloadHash = ethers.keccak256(ethers.toUtf8Bytes(payloadString));

  const domain = getDomain(type, isTestnet);
  const values = { payloadHash, nonce };

  const rawSignature = await wallet.signTypedData(domain, EIP712_TYPES, values);
  const rawSigBytes = ethers.getBytes(rawSignature);
  // SoDEX Go verifier expects recovery ID as 0/1 (crypto.Sign format), while
  // many EVM signature encoders emit 27/28. Normalise either form.
  const recoveryId = rawSigBytes[64];
  if (recoveryId === 27 || recoveryId === 28) {
    rawSigBytes[64] = recoveryId - 27;
  } else if (recoveryId !== 0 && recoveryId !== 1) {
    throw new Error(`Unexpected ECDSA recovery id: ${recoveryId}`);
  }
  const normalizedRawSignature = ethers.hexlify(rawSigBytes);
  const signature = '0x01' + normalizedRawSignature.slice(2);

  return { signature, nonce };
}

/**
 * Resolve the correct `X-API-Key` header value for the current network.
 *
 * - **Mainnet**: the registered API key name (typically its EVM address).
 *   Falls back to the derived address when the user has not configured
 *   a name yet so unsigned GETs still work.
 * - **Testnet**: registered API keys do not exist; sign with the master
 *   wallet's private key and use its derived address as the X-API-Key.
 */
export function resolveApiKey(params: {
  apiKeyName?: string;
  privateKey?: string;
  isTestnet: boolean;
}): string {
  const { apiKeyName, privateKey, isTestnet } = params;
  const derived = deriveAddressFromPrivateKey(privateKey ?? '');
  if (isTestnet) return derived;
  const name = (apiKeyName ?? '').trim();
  return name || derived;
}
