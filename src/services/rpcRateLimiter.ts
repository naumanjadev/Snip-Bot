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
 * Replace with your own RPC keys or endpoints.
 * Make sure you do NOT list duplicates unless absolutely needed.
 */
const rpcUrls = [
  'https://mainnet.helius-rpc.com/?api-key=34f4403f-f9da-4d03-a6df-3de140c97f06',
  'https://mainnet.helius-rpc.com/?api-key=a10fd0ea-2f74-4fb0-bcc3-81dea10eed97',
  'https://mainnet.helius-rpc.com/?api-key=b8332ac9-558f-4da7-9de0-01d8f9c139f0',
  'https://mainnet.helius-rpc.com/?api-key=84ed7da1-c0cf-438b-81a0-fa94a72b89a4',
  'https://mainnet.helius-rpc.com/?api-key=a7582ece-e219-452b-a37f-5a81d45c54d8',
  'https://mainnet.helius-rpc.com/?api-key=28fe0336-263e-43bf-bbdc-7885668ce881',
];

/**
 * A small structure to hold the RPC URL, the Connection, and a “blacklistedUntil” timestamp.
 */
interface RpcConnection {
  url: string;
  connection: Connection;
  blacklistedUntil: number; // epoch ms
}

const rpcConnections: RpcConnection[] = rpcUrls.map((url) => ({
  url,
  connection: new Connection(url, 'confirmed'),
  blacklistedUntil: 0,
}));

/**
 * Retrieve a random Connection that is NOT blacklisted.
 * If all are blacklisted, we pick the one which will be freed soonest,
 * but also log a warning to wait or reduce rate.
 */
export const getRandomConnection = (): Connection => {
  const now = Date.now();
  const validConnections = rpcConnections.filter((c) => c.blacklistedUntil <= now);

  if (validConnections.length === 0) {
    // All blacklisted; pick the earliest recovery
    rpcConnections.sort((a, b) => a.blacklistedUntil - b.blacklistedUntil);
    const earliest = rpcConnections[0];
    logger.warn(
      `All RPC endpoints are temporarily blacklisted. Using ${earliest.url} but requests may fail.`
    );
    return earliest.connection;
  }

  const chosen = validConnections[Math.floor(Math.random() * validConnections.length)];
  logger.debug(`Using RPC endpoint: ${chosen.url}`);
  return chosen.connection;
};

/**
 * Blacklist an RPC URL for a short period if we get a 429 response.
 */
export const blacklistEndpoint = (url: string): void => {
  const now = Date.now();
  const blacklistDuration = 60_000; // e.g. 1 minute
  for (const rpcConn of rpcConnections) {
    if (rpcConn.url === url) {
      rpcConn.blacklistedUntil = now + blacklistDuration;
      logger.warn(
        `Blacklisting endpoint for 60s due to 429 errors: ${url}`
      );
    }
  }
};

// Configure Bottleneck for rate limiting
const limiter = new Bottleneck({
  reservoir: 100,              // Maximum 100 requests
  reservoirRefreshAmount: 100, // Reset to 100
  reservoirRefreshInterval: 60 * 1000, // every 60 seconds
  maxConcurrent: 3,            // Up to 3 concurrent
  minTime: 200,                // ~5 calls/second if reservoir is available
});

/**
 * Delay execution for a specified number of milliseconds.
 */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A wrapper for retrying a function call with exponential backoff.
 */
const retryWrapper = async <T>(
  fn: () => Promise<T>,
  description: string,
  endpointUrl: string,
  retries = 5
): Promise<T> => {
  let attempt = 0;
  const execute = async (): Promise<T> => {
    try {
      return await fn();
    } catch (error: any) {
      logger.error(`Error in ${description}:`, error);

      const is429 =
        (error.response && error.response.status === 429) ||
        (error.code === '429') ||
        error.message?.includes('429') ||
        error.message?.includes('Too Many Requests');

      const isRetryable =
        is429 ||
        (error.response && [500, 502, 503].includes(error.response.status)) ||
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT';

      if (is429) {
        // Blacklist this endpoint for 1 minute
        blacklistEndpoint(endpointUrl);
      }

      if (attempt < retries && isRetryable) {
        const jitter = Math.random() * 100;
        const backoff = Math.pow(2, attempt) * 500 + jitter; // exponential
        attempt++;
        logger.warn(
          `${description} failed with ${
            error.response?.status || error.code || 'Unknown'
          }. Retrying in ${backoff.toFixed(0)}ms... (Attempt ${attempt}/${retries})`
        );
        await delay(backoff);
        return execute();
      } else {
        logger.error(`${description} failed after ${attempt} attempt(s): ${error.message}`);
        throw error;
      }
    }
  };
  return execute();
};

// ------------------------------
// Rate-Limited, Retry-Wrapped RPC calls
// ------------------------------

/**
 * Fetch the Mint info for a given mint address, with rate limiting and retries.
 */
export const getMintWithRateLimit = async (mintAddress: string): Promise<Mint> => {
  const connection = getRandomConnection();
  const endpointUrl = (connection as any)._rpcEndpoint; // internal usage
  return limiter.schedule(() =>
    retryWrapper(
      () => getMint(connection, new PublicKey(mintAddress)),
      `getMint for ${mintAddress}`,
      endpointUrl
    )
  );
};

/**
 * Fetch the token supply for a given mint address, with rate limiting and retries.
 */
export const getTokenSupplyWithRateLimit = async (mintAddress: string): Promise<TokenAmount> => {
  const connection = getRandomConnection();
  const endpointUrl = (connection as any)._rpcEndpoint;
  return limiter.schedule(() =>
    retryWrapper(
      async () => {
        const response: RpcResponseAndContext<TokenAmount> = await connection.getTokenSupply(
          new PublicKey(mintAddress)
        );
        if (!response.value.uiAmountString) {
          throw new Error('uiAmountString is undefined');
        }
        return response.value;
      },
      `getTokenSupply for ${mintAddress}`,
      endpointUrl
    )
  );
};

/**
 * Fetches the largest token accounts for a given mint address, with rate limiting and retries.
 */
export const getTokenLargestAccountsWithRateLimit = async (
  mintAddress: string
): Promise<TokenAccountBalancePair[]> => {
  const connection = getRandomConnection();
  const endpointUrl = (connection as any)._rpcEndpoint;
  return limiter.schedule(() =>
    retryWrapper(
      async () => {
        const response: RpcResponseAndContext<TokenAccountBalancePair[]> =
          await connection.getTokenLargestAccounts(new PublicKey(mintAddress));
        if (!response.value) {
          throw new Error('Largest accounts value is undefined');
        }
        return response.value;
      },
      `getTokenLargestAccounts for ${mintAddress}`,
      endpointUrl
    )
  );
};

/**
 * Fetches parsed account info for a given public key, with rate limiting and retries.
 */
export const getParsedAccountInfoWithRateLimit = async (
  publicKey: string
): Promise<AccountInfo<ParsedAccountData> | null> => {
  const connection = getRandomConnection();
  const endpointUrl = (connection as any)._rpcEndpoint;
  return limiter.schedule(() =>
    retryWrapper(
      async () => {
        const response: RpcResponseAndContext<
          AccountInfo<Buffer | ParsedAccountData> | null
        > = await connection.getParsedAccountInfo(new PublicKey(publicKey));

        const accountInfo = response.value;
        if (
          accountInfo &&
          accountInfo.data &&
          typeof accountInfo.data === 'object' &&
          'parsed' in accountInfo.data
        ) {
          // It's ParsedAccountData
          return accountInfo as AccountInfo<ParsedAccountData>;
        }
        return null;
      },
      `getParsedAccountInfo for ${publicKey}`,
      endpointUrl
    )
  );
};

