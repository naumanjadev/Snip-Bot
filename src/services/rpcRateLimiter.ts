import Bottleneck from 'bottleneck';
import {
  Connection,
  PublicKey,
  AccountInfo,
  TokenAmount,
  ParsedAccountData,
  TokenAccountBalancePair,
  KeyedAccountInfo,
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

interface RpcConnection {
  url: string;
  connection: Connection;
  limiter: Bottleneck;
  blacklistedUntil: number;
  consecutiveErrors: number;
  requestCount: number;  // Track requests instead of using reservoir
}

// Create more conservative rate limits per connection
const createConnectionLimiter = () => new Bottleneck({
  maxConcurrent: 1,             // One request at a time
  minTime: 500,                 // 500ms between requests (~2 req/sec)
});

// Initialize connections with individual rate limiters
const rpcConnections: RpcConnection[] = rpcUrls.map((url) => ({
  url,
  connection: new Connection(url, 'confirmed'),
  limiter: createConnectionLimiter(),
  blacklistedUntil: 0,
  consecutiveErrors: 0,
  requestCount: 0,
}));

// Global limiter for overall rate control
const globalLimiter = new Bottleneck({
  maxConcurrent: 3,           // Allow 3 concurrent requests
  minTime: 100,               // Minimum 100ms between requests
});

// Reset request counts every minute
setInterval(() => {
  rpcConnections.forEach(conn => {
    conn.requestCount = 0;
  });
}, 60 * 1000);

const getHealthyConnection = (): RpcConnection | null => {
  const now = Date.now();
  const available = rpcConnections.filter(c => 
    c.blacklistedUntil <= now && 
    c.consecutiveErrors < 3 &&
    c.requestCount < 15  // Max 15 requests per minute
  );

  if (available.length === 0) {
    // Try to find any connection that's not blacklisted
    const notBlacklisted = rpcConnections.filter(c => c.blacklistedUntil <= now);
    if (notBlacklisted.length === 0) {
      logger.warn('All endpoints are blacklisted, waiting for cooldown');
      return null;
    }
    // Use the one with the least consecutive errors
    return notBlacklisted.sort((a, b) => a.consecutiveErrors - b.consecutiveErrors)[0];
  }

  // Return the connection with the least requests
  return available.sort((a, b) => a.requestCount - b.requestCount)[0];
};

// Export for backward compatibility with existing code
export const getRandomConnection = (): Connection => {
  const conn = getHealthyConnection();
  if (!conn) {
    // Fallback to first connection if all are blacklisted
    return rpcConnections[0].connection;
  }
  return conn.connection;
};

const blacklistConnection = (connection: RpcConnection) => {
  connection.consecutiveErrors++;
  const blacklistDuration = Math.min(
    120_000 * Math.pow(2, connection.consecutiveErrors - 1), // Exponential backoff
    600_000 // Max 10 minutes
  );
  connection.blacklistedUntil = Date.now() + blacklistDuration;
  logger.warn(
    `Endpoint blacklisted for ${blacklistDuration/1000}s after ${connection.consecutiveErrors} errors: ${connection.url}`
  );
};

const resetConnectionErrors = (connection: RpcConnection) => {
  if (connection.consecutiveErrors > 0) {
    connection.consecutiveErrors = 0;
    logger.debug(`Reset error count for endpoint: ${connection.url}`);
  }
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function executeWithRetry<T>(
  operation: () => Promise<T>,
  description: string,
  connection: RpcConnection,
  maxRetries = 3
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      connection.requestCount++;
      const result = await globalLimiter.schedule(() =>
        connection.limiter.schedule(operation)
      );
      resetConnectionErrors(connection);
      return result;
    } catch (error: any) {
      lastError = error;
      logger.error(`Attempt ${attempt + 1}/${maxRetries + 1} failed for ${description}:`, error);

      const is429 = error.message?.includes('429') || error.message?.includes('Too Many Requests');
      const isRetryable = is429 || 
        error.message?.includes('timeout') ||
        error.message?.includes('connection reset');

      if (is429) {
        blacklistConnection(connection);
      }

      if (!isRetryable || attempt === maxRetries) {
        break;
      }

      const backoff = Math.min(1000 * Math.pow(2, attempt), 8000);
      await delay(backoff + Math.random() * 1000);
    }
  }

  throw lastError || new Error(`Operation failed: ${description}`);
}

async function executeWithFallback<T>(
  operation: (conn: Connection) => Promise<T>,
  description: string,
  maxAttempts = 3
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const connection = getHealthyConnection();
    if (!connection) {
      await delay(2000);
      continue;
    }

    try {
      return await executeWithRetry(
        () => operation(connection.connection),
        description,
        connection
      );
    } catch (error) {
      if (attempt === maxAttempts - 1) throw error;
    }
  }
  throw new Error(`All attempts failed for: ${description}`);
}

export const getMintWithRateLimit = async (mintAddress: string): Promise<Mint> =>
  executeWithFallback(
    (connection) => getMint(connection, new PublicKey(mintAddress)),
    `getMint for ${mintAddress}`
  );

export const getTokenSupplyWithRateLimit = async (mintAddress: string): Promise<TokenAmount> =>
  executeWithFallback(
    async (connection) => {
      const resp = await connection.getTokenSupply(new PublicKey(mintAddress));
      if (!resp.value.uiAmountString) {
        throw new Error('uiAmountString is undefined');
      }
      return resp.value;
    },
    `getTokenSupply for ${mintAddress}`
  );

export const getTokenLargestAccountsWithRateLimit = async (
  mintAddress: string
): Promise<TokenAccountBalancePair[]> =>
  executeWithFallback(
    async (connection) => {
      const resp = await connection.getTokenLargestAccounts(new PublicKey(mintAddress));
      if (!resp.value) {
        throw new Error('No largest accounts returned');
      }
      return resp.value;
    },
    `getTokenLargestAccounts for ${mintAddress}`
  );

export const getParsedAccountInfoWithRateLimit = async (
  pubkey: string
): Promise<AccountInfo<ParsedAccountData> | null> =>
  executeWithFallback(
    async (connection) => {
      const resp = await connection.getParsedAccountInfo(new PublicKey(pubkey));
      if (resp.value && typeof resp.value.data === 'object' && 'parsed' in resp.value.data) {
        return resp.value as AccountInfo<ParsedAccountData>;
      }
      return null;
    },
    `getParsedAccountInfo for ${pubkey}`
  );