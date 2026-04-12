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
 * Deterministic JSON serialiser: recursively sorts object keys so that
 * `{ b: 1, a: 2 }` and `{ a: 2, b: 1 }` produce the same string and
 * therefore the same keccak256 hash. Arrays preserve their element order
 * but any objects within them are also key-sorted recursively.
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as object).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export async function signPayload(
  payload: any,
  privateKey: string,
  type: DomainType,
  isTestnet: boolean
): Promise<{ signature: string; nonce: string }> {
  const wallet = new ethers.Wallet(privateKey);
  const nonce = getMonotonicNonce();
  
  const payloadString = stableStringify(payload ?? {});
  const payloadHash = ethers.keccak256(ethers.toUtf8Bytes(payloadString));

  const domain = getDomain(type, isTestnet);
  const values = {
    payloadHash,
    nonce,
  };

  const rawSignature = await wallet.signTypedData(domain, EIP712_TYPES, values);
  const signature = "0x01" + rawSignature.slice(2);

  return { signature, nonce };
}
