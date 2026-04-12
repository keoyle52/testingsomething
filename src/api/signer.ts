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

export async function signPayload(
  payload: any,
  privateKey: string,
  type: DomainType,
  isTestnet: boolean
): Promise<{ signature: string; nonce: string }> {
  const wallet = new ethers.Wallet(privateKey);
  const nonce = BigInt(Date.now()).toString();
  
  const payloadString = JSON.stringify(payload || {});
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
