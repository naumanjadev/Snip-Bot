import Bottleneck from 'bottleneck';
import {
  Connection,
  PublicKey,
  AccountInfo,
  TokenAmount,
  ParsedAccountData,
  TokenAccountBalancePair,
} from '@solana/web3.js';
import { getMint, Mint } from '@solana/spl-token';
import { logger } from '../utils/logger';

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
  lastUsed: number;
}

// Much stricter rate limits per connection
const createConnectionLimiter = () => new Bottleneck({
  maxConcurrent: 1,
  minTime: 1000,              // Minimum 1 second between requests
  reservoir: 10,              // Start with 10 tokens
  reservoirRefreshAmount: 10, // Refill to 10 tokens
  reservoirRefreshInterval: 60 * 1000  // Every 60 seconds
});

// Significantly reduced global rate limiting
const globalLimiter = new Bottleneck({
  maxConcurrent: 2,          // Only 2 concurrent requests globally
  minTime: 200,              // 200ms between any requests
  reservoir: 30,             // 30 requests per minute total
  reservoirRefreshAmount: 30,
  reservoirRefreshInterval: 60 * 1000
});

const rpcConnections: RpcConnection[] = rpcUrls.map((url) => ({
  url,
  connection: new Connection(url, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true, // We'll handle retries ourselves
  }),
  limiter: createConnectionLimiter(),
  blacklistedUntil: 0,
  consecutiveErrors: 0,
  lastUsed: 0,
}));

const getHealthyConnection = (): RpcConnection | null => {
  const now = Date.now();
  
  // Remove blacklisting for connections that have cooled down
  rpcConnections.forEach(conn => {
    if (conn.blacklistedUntil <= now) {
      conn.blacklistedUntil = 0;
      if (now - conn.lastUsed > 120000) { // 2 minutes without use
        conn.consecutiveErrors = 0; // Reset errors after cooling period
      }
    }
  });

  // Filter available connections
  const available = rpcConnections.filter(c => 
    c.blacklistedUntil <= now && 
    c.consecutiveErrors < 2 && // More aggressive error threshold
    (now - c.lastUsed) >= 1000 // Ensure 1 second between uses of same connection
  );

  if (available.length === 0) {
    logger.warn('No healthy connections available, waiting for cooldown...');
    return null;
  }

  // Sort by least recently used and least errors
  available.sort((a, b) => {
    const timeDiff = a.lastUsed - b.lastUsed;
    if (Math.abs(timeDiff) > 5000) { // Significant time difference
      return timeDiff;
    }
    return a.consecutiveErrors - b.consecutiveErrors;
  });

  return available[0];
};

const blacklistConnection = (connection: RpcConnection) => {
  connection.consecutiveErrors++;
  const blacklistDuration = Math.min(
    180_000 * Math.pow(2, connection.consecutiveErrors - 1), // Longer backoff
    900_000 // Max 15 minutes
  );
  connection.blacklistedUntil = Date.now() + blacklistDuration;
  logger.warn(
    `Endpoint blacklisted for ${blacklistDuration/1000}s after ${connection.consecutiveErrors} errors: ${connection.url}`
  );
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function executeWithRetry<T>(
  operation: () => Promise<T>,
  description: string,
  connection: RpcConnection,
  maxRetries = 3
): Promise<T> {
  let lastError: Error | null = null;
  let baseDelay = 2000; // Start with 2 second base delay
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      connection.lastUsed = Date.now();
      
      // Use both limiters in series
      const result = await globalLimiter.schedule(() =>
        connection.limiter.schedule(operation)
      );
      
      connection.consecutiveErrors = 0; // Reset errors on success
      return result;
    } catch (error: any) {
      lastError = error;
      logger.error(
        `Attempt ${attempt + 1}/${maxRetries + 1} failed for ${description}:`,
        error.message || error
      );

      const is429 = error.message?.includes('429') || 
                    error.message?.includes('Too Many Requests');
      
      if (is429) {
        blacklistConnection(connection);
        // Increase base delay after each 429
        baseDelay = Math.min(baseDelay * 2, 8000);
      }

      if (attempt === maxRetries) break;

      // Calculate backoff with jitter
      const jitter = Math.random() * 1000;
      const backoff = baseDelay * Math.pow(2, attempt) + jitter;
      await delay(backoff);
    }
  }

  throw lastError || new Error(`Operation failed: ${description}`);
}

async function executeWithFallback<T>(
  operation: (conn: Connection) => Promise<T>,
  description: string,
  maxAttempts = 3
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const connection = getHealthyConnection();
    if (!connection) {
      await delay(3000); // Longer delay when no connections available
      continue;
    }

    try {
      return await executeWithRetry(
        () => operation(connection.connection),
        description,
        connection
      );
    } catch (error: any) {
      lastError = error;
      if (attempt === maxAttempts - 1) break;
      await delay(2000); // Delay before trying next connection
    }
  }

  throw lastError || new Error(`All attempts failed for: ${description}`);
}

// Export for backward compatibility
export const getRandomConnection = (): Connection => {
  const conn = getHealthyConnection();
  return conn ? conn.connection : rpcConnections[0].connection;
};

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