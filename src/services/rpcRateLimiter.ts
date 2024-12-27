// src/services/rpcRateLimiter.ts

import Bottleneck from 'bottleneck';
import {
  Connection,
  PublicKey,
  AccountInfo,
  RpcResponseAndContext,
  TokenAccountBalancePair,
  TokenAmount,
  ParsedAccountData,
} from '@solana/web3.js';
import { getMint, Mint } from '@solana/spl-token';
import { logger } from '../utils/logger';

/**
 * List your RPC endpoints carefully. 
 * Avoid duplicates, or you risk quickly blacklisting them all.
 */
const rpcUrls = [
  'https://mainnet.helius-rpc.com/?api-key=34f4403f-f9da-4d03-a6df-3de140c97f06',
  'https://mainnet.helius-rpc.com/?api-key=a10fd0ea-2f74-4fb0-bcc3-81dea10eed97',
  'https://mainnet.helius-rpc.com/?api-key=b8332ac9-558f-4da7-9de0-01d8f9c139f0',
  'https://mainnet.helius-rpc.com/?api-key=84ed7da1-c0cf-438b-81a0-fa94a72b89a4',
  'https://mainnet.helius-rpc.com/?api-key=a7582ece-e219-452b-a37f-5a81d45c54d8',
  'https://mainnet.helius-rpc.com/?api-key=28fe0336-263e-43bf-bbdc-7885668ce881',
];

/** Each RPC connection plus a blacklistedUntil timestamp. */
interface RpcConnection {
  url: string;
  connection: Connection;
  blacklistedUntil: number; // epoch ms
}

/** Create an array of connections; none are blacklisted initially. */
const rpcConnections: RpcConnection[] = rpcUrls.map((url) => ({
  url,
  connection: new Connection(url, 'confirmed'),
  blacklistedUntil: 0,
}));

/**
 * Get a random Connection that isn’t blacklisted. 
 * If all are blacklisted, pick the earliest to be free 
 * (and warn that we might fail).
 */
export const getRandomConnection = (): Connection => {
  const now = Date.now();
  const valid = rpcConnections.filter((c) => c.blacklistedUntil <= now);

  if (valid.length === 0) {
    // All blacklisted
    rpcConnections.sort((a, b) => a.blacklistedUntil - b.blacklistedUntil);
    const earliest = rpcConnections[0];
    logger.warn(
      `All endpoints are blacklisted. Using ${earliest.url} but requests may fail.`
    );
    return earliest.connection;
  }

  const chosen = valid[Math.floor(Math.random() * valid.length)];
  logger.debug(`Using RPC endpoint: ${chosen.url}`);
  return chosen.connection;
};

/** 
 * Blacklist an endpoint for 2–3 minutes if we get a 429 
 * or similar error. 
 */
export const blacklistEndpoint = (url: string): void => {
  const now = Date.now();
  const blacklistMs = 2 * 60_000; // 2 minutes, adjust to 3 if needed
  for (const rc of rpcConnections) {
    if (rc.url === url) {
      rc.blacklistedUntil = now + blacklistMs;
      logger.warn(`Endpoint blacklisted for 2 min due to 429: ${url}`);
    }
  }
};

/** Bottleneck config with stricter limits. */
const limiter = new Bottleneck({
  reservoir: 30,               // only 30 requests per reservoir cycle
  reservoirRefreshAmount: 30,  // reset back to 30
  reservoirRefreshInterval: 60 * 1000, // every 60 seconds
  maxConcurrent: 1,            // only 1 request at a time
  minTime: 300,                // 300ms between requests => ~3.3 calls/second
});

/** Delay helper */
const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * Retry logic with exponential backoff. 
 * If we see 429, we blacklist the endpoint for a while.
 */
const retryWrapper = async <T>(
  fn: () => Promise<T>,
  description: string,
  endpointUrl: string,
  retries = 5
): Promise<T> => {
  let attempt = 0;
  async function run(): Promise<T> {
    try {
      return await fn();
    } catch (error: any) {
      logger.error(`Error in ${description}:`, error);

      const is429 =
        (error.response && error.response.status === 429) ||
        error.message?.includes('429') ||
        error.message?.includes('Too Many Requests');

      const isRetryable =
        is429 ||
        (error.response && [500, 502, 503].includes(error.response.status)) ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ECONNRESET';

      if (is429) {
        // Blacklist this endpoint for a few minutes
        blacklistEndpoint(endpointUrl);
      }

      if (attempt < retries && isRetryable) {
        attempt++;
        const jitter = Math.random() * 100;
        const backoff = Math.pow(2, attempt) * 500 + jitter;
        logger.warn(
          `${description} failed with ${
            error.response?.status || error.code || 'Unknown'
          }. Retrying in ${backoff.toFixed(0)}ms... (Attempt ${attempt}/${retries})`
        );
        await delay(backoff);
        return run();
      } else {
        logger.error(
          `${description} failed after ${attempt} attempt(s): ${error.message}`
        );
        throw error;
      }
    }
  }
  return run();
};

/** 
 * Rate-limited and retry-wrapped calls.
 */

export const getMintWithRateLimit = async (mintAddress: string): Promise<Mint> => {
  const connection = getRandomConnection();
  const endpointUrl = (connection as any)._rpcEndpoint; // internal
  return limiter.schedule(() =>
    retryWrapper(
      () => getMint(connection, new PublicKey(mintAddress)),
      `getMint for ${mintAddress}`,
      endpointUrl
    )
  );
};

export const getTokenSupplyWithRateLimit = async (mintAddress: string): Promise<TokenAmount> => {
  const connection = getRandomConnection();
  const endpointUrl = (connection as any)._rpcEndpoint;
  return limiter.schedule(() =>
    retryWrapper(async () => {
      const resp = await connection.getTokenSupply(new PublicKey(mintAddress));
      if (!resp.value.uiAmountString) {
        throw new Error('uiAmountString is undefined');
      }
      return resp.value;
    }, `getTokenSupply for ${mintAddress}`, endpointUrl)
  );
};

export const getTokenLargestAccountsWithRateLimit = async (
  mintAddress: string
): Promise<TokenAccountBalancePair[]> => {
  const connection = getRandomConnection();
  const endpointUrl = (connection as any)._rpcEndpoint;
  return limiter.schedule(() =>
    retryWrapper(async () => {
      const resp = await connection.getTokenLargestAccounts(new PublicKey(mintAddress));
      if (!resp.value) {
        throw new Error('No largest accounts returned');
      }
      return resp.value;
    }, `getTokenLargestAccounts for ${mintAddress}`, endpointUrl)
  );
};

export const getParsedAccountInfoWithRateLimit = async (
  pubkey: string
): Promise<AccountInfo<ParsedAccountData> | null> => {
  const connection = getRandomConnection();
  const endpointUrl = (connection as any)._rpcEndpoint;
  return limiter.schedule(() =>
    retryWrapper(async () => {
      const resp = await connection.getParsedAccountInfo(new PublicKey(pubkey));
      if (resp.value && typeof resp.value.data === 'object' && 'parsed' in resp.value.data) {
        return resp.value as AccountInfo<ParsedAccountData>;
      }
      return null;
    }, `getParsedAccountInfo for ${pubkey}`, endpointUrl)
  );
};
