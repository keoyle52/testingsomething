import { ethers } from 'ethers';

const DUMMY_CONTRACT = '0x0000000000000000000000000000000000000000';

type DomainType = 'spot' | 'futures';

export const getDomain = (type: DomainType, isTestnet: boolean) => ({
  name: type,
  version: '1',
  chainId: isTestnet ? 138565 : 286623,
  verifyingContract: DUMMY_CONTRACT,
});

export const EIP712_TYPES = {
  ExchangeAction: [
    { name: 'payloadHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint64' },
  ],
};

/**
 * Monotonic nonce generator.
 * Guarantees a strictly increasing nonce even when multiple requests are
 * dispatched within the same millisecond, preventing nonce-collision
 * signature rejections from the exchange.
 */
let _lastNonce = BigInt(0);
export function getMonotonicNonce(): string {
  const now = BigInt(Date.now());
  _lastNonce = now > _lastNonce ? now : _lastNonce + BigInt(1);
  return _lastNonce.toString();
}

/**
 * Derive the Sodex action type string from an HTTP method and URL path.
 * Used by the axios interceptors to build the correct payloadHash wrapper.
 */
export function deriveActionType(method: string, url: string): string {
  const m = method.toUpperCase();
  if (url.includes('/trade/orders/schedule-cancel')) return 'scheduleCancel';
  if (url.includes('/trade/orders/replace')) return 'replaceOrder';
  if (url.includes('/trade/orders/modify')) return 'modifyOrder';
  if (url.includes('/trade/orders') && m === 'DELETE') return 'cancelOrder';
  if (url.includes('/trade/orders')) return 'newOrder';
  if (url.includes('/accounts/transfers')) return 'transferAsset';
  if (url.includes('/leverage')) return 'updateLeverage';
  if (url.includes('/margin')) return 'updateMargin';
  return 'action';
}

/**
 * Sign a Sodex write request using EIP-712.
 *
 * payloadHash is computed as:
 *   keccak256(JSON.stringify({ "type": actionType, "params": payload }))
 *
 * The key order in the params object must match the Go struct field order
 * (JSON.stringify preserves insertion order, so callers must construct
 * objects in the correct order).
 *
 * The returned signature has the Sodex typed-signature prefix byte (0x01)
 * prepended.
 */
export async function signPayload(
  actionType: string,
  payload: any,
  privateKey: string,
  type: DomainType,
  isTestnet: boolean
): Promise<{ signature: string; nonce: string }> {
  const wallet = new ethers.Wallet(privateKey);
  const nonce = getMonotonicNonce();

  // Wrap in the {type, params} envelope required by Sodex before hashing.
  // JSON.stringify without replacer/indent preserves insertion order of
  // object keys, which must match the Go struct field order.
  const signingPayload = { type: actionType, params: payload ?? {} };
  const payloadString = JSON.stringify(signingPayload);
  const payloadHash = ethers.keccak256(ethers.toUtf8Bytes(payloadString));

  const domain = getDomain(type, isTestnet);
  const values = {
    payloadHash,
    nonce,
  };

  const rawSignature = await wallet.signTypedData(domain, EIP712_TYPES, values);
  const rawSigBytes = ethers.getBytes(rawSignature);
  // SoDEX Go verifier expects recovery ID as 0/1 (crypto.Sign format), while
  // many EVM signature encoders emit 27/28.
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
