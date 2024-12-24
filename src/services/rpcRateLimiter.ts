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

// You can store multiple RPC URLs for load distribution
const rpcUrls = [
  'https://mainnet.helius-rpc.com/?api-key=34f4403f-f9da-4d03-a6df-3de140c97f06',
  'https://mainnet.helius-rpc.com/?api-key=a10fd0ea-2f74-4fb0-bcc3-81dea10eed97',
  'https://mainnet.helius-rpc.com/?api-key=b8332ac9-558f-4da7-9de0-01d8f9c139f0',
  'https://mainnet.helius-rpc.com/?api-key=84ed7da1-c0cf-438b-81a0-fa94a72b89a4',
  'https://mainnet.helius-rpc.com/?api-key=84ed7da1-c0cf-438b-81a0-fa94a72b89a4',
  'https://mainnet.helius-rpc.com/?api-key=a7582ece-e219-452b-a37f-5a81d45c54d8',

  // Add more RPC URLs if available for load balancing/failoverhttps://mainnet.helius-rpc.com/?api-key=84ed7da1-c0cf-438b-81a0-fa94a72b89a4
];

const connections = rpcUrls.map(url => new Connection(url, 'confirmed'));

const getRandomConnection = () => connections[Math.floor(Math.random() * connections.length)];

// Configure Bottleneck for rate limiting
const limiter = new Bottleneck({
  reservoir: 200,
  reservoirRefreshAmount: 200,
  reservoirRefreshInterval: 60 * 1000, // refresh every 60s
  maxConcurrent: 10,
  minTime: 100,
});

/**
 * Delay execution for a specified number of milliseconds.
 * @param ms The number of milliseconds to delay.
 */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A wrapper for retrying a function call with exponential backoff on certain errors.
 * Adjust the logic and errors as needed.
 *
 * @param fn The function to execute.
 * @param description A descriptive name for logging.
 * @param retries Number of retry attempts.
 */
const retryWrapper = async <T>(
  fn: () => Promise<T>,
  description: string,
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
        error.message.includes('429') ||
        error.message.includes('Too Many Requests');

      const isRetryable =
        is429 ||
        (error.response && [500, 502, 503].includes(error.response.status)) ||
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT';

      if (attempt < retries && isRetryable) {
        const jitter = Math.random() * 100; // Random delay up to 100ms
        const backoff = Math.pow(2, attempt) * 500 + jitter; // exponential backoff
        logger.warn(
          `${description} failed with ${error.response?.status || error.code || 'Unknown'}.
           Retrying in ${backoff.toFixed(0)}ms... (Attempt ${attempt + 1}/${retries})`
        );
        await delay(backoff);
        attempt++;
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
 * Fetches the Mint information for a given mint address with rate limiting and retries.
 * @param mintAddress The mint address as a string.
 * @returns Mint information.
 */
export const getMintWithRateLimit = async (mintAddress: string): Promise<Mint> => {
  const connection = getRandomConnection();
  return limiter.schedule(() =>
    retryWrapper(
      () => getMint(connection, new PublicKey(mintAddress)),
      `getMint for ${mintAddress}`
    )
  );
};

/**
 * Fetches the token supply for a given mint address with rate limiting and retries.
 * @param mintAddress The mint address as a string.
 * @returns Token supply information.
 */
export const getTokenSupplyWithRateLimit = async (
  mintAddress: string
): Promise<TokenAmount> => {
  const connection = getRandomConnection();
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
      `getTokenSupply for ${mintAddress}`
    )
  );
};

/**
 * Fetches the largest token accounts for a given mint address with rate limiting and retries.
 * @param mintAddress The mint address as a string.
 * @returns Array of largest token accounts.
 */
export const getTokenLargestAccountsWithRateLimit = async (
  mintAddress: string
): Promise<TokenAccountBalancePair[]> => {
  const connection = getRandomConnection();
  return limiter.schedule(() =>
    retryWrapper(
      async () => {
        const response: RpcResponseAndContext<TokenAccountBalancePair[]> = await connection.getTokenLargestAccounts(
          new PublicKey(mintAddress)
        );
        if (!response.value) {
          throw new Error('Largest accounts value is undefined');
        }
        return response.value;
      },
      `getTokenLargestAccounts for ${mintAddress}`
    )
  );
};

/**
 * Fetches parsed account info for a given public key with rate limiting and retries.
 * Useful if you need to look up specific account balances not found in largest accounts.
 *
 * @param publicKey The public key as a string.
 * @returns Parsed account information or null.
 */
export const getParsedAccountInfoWithRateLimit = async (
  publicKey: string
): Promise<AccountInfo<ParsedAccountData> | null> => {
  const connection = getRandomConnection();
  return limiter.schedule(() =>
    retryWrapper(
      async () => {
        const response: RpcResponseAndContext<AccountInfo<Buffer | ParsedAccountData> | null> =
          await connection.getParsedAccountInfo(new PublicKey(publicKey));

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
      `getParsedAccountInfo for ${publicKey}`
    )
  );
};
