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

// Enhanced interface with additional tracking
interface RpcConnection {
  url: string;
  connection: Connection;
  limiter: Bottleneck;
  blacklistedUntil: number;
  consecutiveErrors: number;
  lastUsed: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  lastErrorTime?: number;
}

// More conservative rate limits
const createConnectionLimiter = () => new Bottleneck({
  maxConcurrent: 1,
  minTime: 2000,              // 2 seconds between requests
  reservoir: 5,               // Start with 5 tokens
  reservoirRefreshAmount: 5,  // Refill to 5 tokens
  reservoirRefreshInterval: 60 * 1000  // Every 60 seconds
});

// Even more conservative global rate limiting
const globalLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 500,
  reservoir: 20,
  reservoirRefreshAmount: 20,
  reservoirRefreshInterval: 60 * 1000
});

// Enhanced validator for mint addresses
const isValidMintAddress = (address: string): boolean => {
  try {
    const pubkey = new PublicKey(address);
    return PublicKey.isOnCurve(pubkey.toBytes());
  } catch (error) {
    return false;
  }
};

const rpcConnections: RpcConnection[] = rpcUrls.map((url) => ({
  url,
  connection: new Connection(url, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
  }),
  limiter: createConnectionLimiter(),
  blacklistedUntil: 0,
  consecutiveErrors: 0,
  lastUsed: 0,
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
}));

// Enhanced connection selection with load balancing
const getHealthyConnection = (): RpcConnection | null => {
  const now = Date.now();
  
  rpcConnections.forEach(conn => {
    if (conn.blacklistedUntil <= now) {
      conn.blacklistedUntil = 0;
      if (now - conn.lastUsed > 300000) { // 5 minutes without use
        conn.consecutiveErrors = 0;
        conn.lastErrorTime = undefined;
      }
    }
  });

  const available = rpcConnections.filter(c => 
    c.blacklistedUntil <= now && 
    c.consecutiveErrors < 3 &&
    (now - c.lastUsed) >= 2000
  );

  if (available.length === 0) {
    logger.warn('No healthy connections available, waiting for cooldown...');
    return null;
  }

  // Enhanced sorting considering success rate
  available.sort((a, b) => {
    const aSuccessRate = a.successfulRequests / (a.totalRequests || 1);
    const bSuccessRate = b.successfulRequests / (b.totalRequests || 1);
    
    const timeDiff = a.lastUsed - b.lastUsed;
    const successRateDiff = bSuccessRate - aSuccessRate;
    
    if (Math.abs(successRateDiff) > 0.2) {
      return successRateDiff > 0 ? 1 : -1;
    }
    
    return timeDiff;
  });

  return available[0];
};

// Enhanced blacklisting with exponential backoff
const blacklistConnection = (connection: RpcConnection) => {
  connection.consecutiveErrors++;
  connection.failedRequests++;
  connection.lastErrorTime = Date.now();

  const baseBackoff = 60_000; // 1 minute
  const maxBackoff = 1800_000; // 30 minutes
  
  const backoff = Math.min(
    baseBackoff * Math.pow(2, connection.consecutiveErrors - 1),
    maxBackoff
  );

  connection.blacklistedUntil = Date.now() + backoff;
  
  logger.warn(
    `Endpoint blacklisted for ${backoff/1000}s after ${connection.consecutiveErrors} errors: ${connection.url}`
  );
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Enhanced retry logic with adaptive delays
async function executeWithRetry<T>(
  operation: () => Promise<T>,
  description: string,
  connection: RpcConnection,
  maxRetries = 5
): Promise<T> {
  let lastError: Error | null = null;
  let baseDelay = 1000;
  
  connection.totalRequests++;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      connection.lastUsed = Date.now();
      
      const result = await globalLimiter.schedule(() =>
        connection.limiter.schedule(operation)
      );
      
      connection.consecutiveErrors = 0;
      connection.successfulRequests++;
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
        baseDelay = Math.min(baseDelay * 2, 8000);
      }

      if (attempt === maxRetries) break;

      const jitter = Math.random() * baseDelay * 0.1;
      const backoff = baseDelay * Math.pow(1.5, attempt) + jitter;
      await delay(backoff);
    }
  }

  throw lastError || new Error(`Operation failed: ${description}`);
}

// Enhanced fallback with pre-validation
async function executeWithFallback<T>(
  operation: (conn: Connection) => Promise<T>,
  description: string,
  maxAttempts = 5
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const connection = getHealthyConnection();
    if (!connection) {
      await delay(5000);
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
      await delay(3000);
    }
  }

  throw lastError || new Error(`All attempts failed for: ${description}`);
}

// Enhanced mint validation
export const getMintWithRateLimit = async (mintAddress: string): Promise<Mint> => {
  if (!isValidMintAddress(mintAddress)) {
    throw new Error(`Invalid mint address format: ${mintAddress}`);
  }

  return executeWithFallback(
    (connection) => getMint(connection, new PublicKey(mintAddress)),
    `getMint for ${mintAddress}`
  );
};

export const getTokenSupplyWithRateLimit = async (mintAddress: string): Promise<TokenAmount> => {
  if (!isValidMintAddress(mintAddress)) {
    throw new Error(`Invalid mint address format: ${mintAddress}`);
  }

  return executeWithFallback(
    async (connection) => {
      const resp = await connection.getTokenSupply(new PublicKey(mintAddress));
      if (!resp.value.uiAmountString) {
        throw new Error('uiAmountString is undefined');
      }
      return resp.value;
    },
    `getTokenSupply for ${mintAddress}`
  );
};

export const getTokenLargestAccountsWithRateLimit = async (
  mintAddress: string
): Promise<TokenAccountBalancePair[]> => {
  if (!isValidMintAddress(mintAddress)) {
    throw new Error(`Invalid mint address format: ${mintAddress}`);
  }

  return executeWithFallback(
    async (connection) => {
      const resp = await connection.getTokenLargestAccounts(new PublicKey(mintAddress));
      if (!resp.value) {
        throw new Error('No largest accounts returned');
      }
      return resp.value;
    },
    `getTokenLargestAccounts for ${mintAddress}`
  );
};

export const getParsedAccountInfoWithRateLimit = async (
  pubkey: string
): Promise<AccountInfo<ParsedAccountData> | null> => {
  if (!isValidMintAddress(pubkey)) {
    throw new Error(`Invalid public key format: ${pubkey}`);
  }

  return executeWithFallback(
    async (connection) => {
      const resp = await connection.getParsedAccountInfo(new PublicKey(pubkey));
      if (resp.value && typeof resp.value.data === 'object' && 'parsed' in resp.value.data) {
        return resp.value as AccountInfo<ParsedAccountData>;
      }
      return null;
    },
    `getParsedAccountInfo for ${pubkey}`
  );
};

// Export for backward compatibility
export const getRandomConnection = (): Connection => {
  const conn = getHealthyConnection();
  return conn ? conn.connection : rpcConnections[0].connection;
};