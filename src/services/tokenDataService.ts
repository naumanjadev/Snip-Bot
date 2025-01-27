import { PublicKey, Connection, clusterApiUrl } from '@solana/web3.js';
import { getCache, setCache } from './cacheService';
import axios from 'axios';
import { logger } from '../utils/logger';
import { TokenInfo } from '../types';
import { purchaseToken } from './purchaseService';
import { botInstance } from '../bots/telegramBot';
import { fetchTokenMetadata } from './tokenMetadataService';
import {
  getMintWithRateLimit,
  getTokenSupplyWithRateLimit,
  getTokenLargestAccountsWithRateLimit,
} from './rpcRateLimiter';
import { Mint, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { TokenAccountBalancePair, TokenAmount } from '@solana/web3.js';

const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');

interface TokenDataPayload {
  pubkey: string;
  account: {
    data: {
      parsed: {
        type: string; // "mint" for mint accounts
        info: {
          mintAuthority?: string;
          supply?: string;
          decimals?: number;
        };
      };
    };
    owner: string;
  };
}

// Reduce from 5 to 2 or 3 if you like to limit spammy logs
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 500;
const FETCH_TIMEOUT_MS = 30000;
const CACHE_KEY = 'splTokenData';
const CACHE_TTL_SECONDS = 120;

let fetchPromise: Promise<TokenDataPayload[]> | null = null;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function isLikelyValidMint(mintAddress: string): Promise<boolean> {
  // Quick parse check
  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(mintAddress);
  } catch {
    // definitely not valid
    return false;
  }
  // Next, do a quick on-chain check
  try {
    const info = await connection.getParsedAccountInfo(pubkey);
    if (info.value && 'parsed' in info.value.data) {
      const parsed = (info.value.data as any).parsed;
      return parsed?.type === 'mint';
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Use a cached approach to fetch all 82-byte mint accounts
 * from a Solana program scan (via Helius).
 */
export const fetchSplTokenDataWithCache = async (): Promise<TokenDataPayload[]> => {
  const cachedData = await getCache(CACHE_KEY);
  if (cachedData) {
    try {
      const tokens = JSON.parse(cachedData);
      if (Array.isArray(tokens)) {
        logger.info('Using cached SPL token data.');
        return tokens as TokenDataPayload[];
      }
      logger.warn('Cached SPL token data is not an array. Clearing cache...');
      await setCache(CACHE_KEY, '', 1);
    } catch (err) {
      logger.warn('Error parsing cached SPL token data. Clearing cache...', err);
      await setCache(CACHE_KEY, '', 1);
    }
  }

  // If a fetch is in progress, await it
  if (fetchPromise) {
    logger.debug('Fetch of SPL token data already in progress, awaiting...');
    return fetchPromise;
  }

  fetchPromise = new Promise<TokenDataPayload[]>((resolve) => {
    const timer = setTimeout(() => {
      logger.error('Fetch of SPL token data timed out.');
      fetchPromise = null;
      resolve([]);
    }, FETCH_TIMEOUT_MS);

    // Example Helius endpoint with your key
    const url = 'https://mainnet.helius-rpc.com/?api-key=a7582ece-e219-452b-a37f-5a81d45c54d8';

    let attempt = 0;
    let backoff = INITIAL_BACKOFF_MS;

    const doFetch = async () => {
      while (attempt < MAX_RETRIES) {
        try {
          const response = await axios.post(
            url,
            {
              jsonrpc: '2.0',
              id: 1,
              method: 'getProgramAccounts',
              params: [
                TOKEN_PROGRAM_ID.toBase58(),
                {
                  encoding: 'jsonParsed',
                  filters: [{ dataSize: 82 }], // Only mint accounts = 82 bytes
                },
              ],
            },
            { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
          );

          if (response.status === 200 && response.data?.result) {
            const tokens = response.data.result;
            await setCache(CACHE_KEY, JSON.stringify(tokens), CACHE_TTL_SECONDS);
            logger.info('Fetched and cached SPL token data.');
            clearTimeout(timer);
            fetchPromise = null;
            resolve(tokens);
            return;
          } else if (response.status === 429) {
            logger.warn(`Rate limit (429) encountered. Waiting ${backoff}ms and retrying...`);
            await delay(backoff);
            backoff = Math.min(backoff * 2, 60000);
          } else {
            logger.warn(
              `Unexpected response: ${response.status}, Data: ${JSON.stringify(response.data).slice(
                0,
                200
              )}. Retrying...`
            );
            await delay(backoff);
            backoff = Math.min(backoff * 2, 60000);
          }
        } catch (error: any) {
          const message = axios.isAxiosError(error) ? error.message : String(error);
          logger.warn(`Attempt ${attempt + 1} failed: ${message}. Waiting ${backoff}ms and retrying...`);
          await delay(backoff);
          backoff = Math.min(backoff * 2, 60000);
        }
        attempt++;
      }
      clearTimeout(timer);
      fetchPromise = null;
      logger.error('Max retries reached. Unable to fetch SPL token data.');
      resolve([]);
    };

    doFetch();
  });

  return fetchPromise;
};

/**
 * Safely fetch the Mint info from chain, skipping if invalid or can't parse.
 */
const safeGetMintInfo = async (mintAddress: string): Promise<Mint | null> => {
  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(mintAddress);
  } catch {
    logger.warn(`Invalid mint address: ${mintAddress}. Skipping mint info fetch.`);
    return null;
  }

  // Check if it's a valid mint account
  const valid = await isLikelyValidMint(mintAddress);
  if (!valid) {
    logger.warn(`Not a valid mint structure: ${mintAddress}. Skipping.`);
    return null;
  }

  // Fetch chain data
  try {
    const mintInfo: Mint = await getMintWithRateLimit(mintAddress);
    return mintInfo;
  } catch (error: any) {
    logger.warn(`safeGetMintInfo error for ${mintAddress}: ${error.message}`);
    return null;
  }
};

/**
 * Example "liquidity" function by minted supply. Adjust for your use-case.
 */
export const getLiquidity = async (mintAddress: string): Promise<number> => {
  const mintInfo = await safeGetMintInfo(mintAddress);
  if (!mintInfo) {
    logger.warn(`Cannot compute liquidity for ${mintAddress}: Mint info not available.`);
    return 0;
  }
  const totalSupply = Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals);
  // Subtract any known non-circulating if you wish
  const nonCirculatingSupply = 0;
  const circulatingSupply = totalSupply - nonCirculatingSupply;
  logger.info(`Calculated circulating supply for ${mintAddress}: ${circulatingSupply}`);
  return circulatingSupply;
};

export const hasMintAuthority = async (mintAddress: string): Promise<boolean> => {
  const mintInfo = await safeGetMintInfo(mintAddress);
  if (!mintInfo) {
    logger.warn(`Cannot check mint authority for ${mintAddress}: Mint info not available.`);
    return false;
  }
  const hasAuthority = mintInfo.mintAuthority !== null;
  logger.info(`Mint ${mintAddress} has mint authority: ${hasAuthority}`);
  return hasAuthority;
};

export const getTopHoldersConcentration = async (
  mintAddress: string,
  topN = 10
): Promise<number> => {
  // Quick parse check
  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(mintAddress);
  } catch {
    logger.warn(`Invalid mint address: ${mintAddress}. Skipping top holders concentration.`);
    return 0;
  }

  const valid = await isLikelyValidMint(mintAddress);
  if (!valid) {
    logger.warn(`Not a valid mint structure: ${mintAddress}. Skipping concentration calc.`);
    return 0;
  }

  try {
    const largestAccounts: TokenAccountBalancePair[] =
      await getTokenLargestAccountsWithRateLimit(mintAddress);

    if (!largestAccounts || largestAccounts.length === 0) {
      logger.warn(`No token accounts found for mint ${mintAddress}.`);
      return 0;
    }

    const supplyResponse: TokenAmount = await getTokenSupplyWithRateLimit(mintAddress);
    const totalSupply = supplyResponse.uiAmount || 0;
    if (totalSupply === 0) {
      logger.warn(`Total supply is zero for ${mintAddress}. Cannot compute concentration.`);
      return 0;
    }

    const sortedAccounts = largestAccounts.sort(
      (a, b) => (b.uiAmount || 0) - (a.uiAmount || 0)
    );
    const topAccounts = sortedAccounts.slice(0, topN);
    const topSum = topAccounts.reduce((sum, acc) => sum + (acc.uiAmount || 0), 0);
    const concentration = (topSum / totalSupply) * 100;
    logger.info(`Top ${topN} holders concentration for ${mintAddress}: ${concentration.toFixed(2)}%`);
    return concentration;
  } catch (error: any) {
    logger.error(`Error in getTopHoldersConcentration for ${mintAddress}:`, error);
    return 0;
  }
};

/**
 * Example pipeline step once a new token is detected.
 * Adjust as needed.
 */
export const processNewToken = async (mintAddress: string) => {
  try {
    new PublicKey(mintAddress);
  } catch {
    logger.warn(`Invalid mint address: ${mintAddress}. Not processing.`);
    return;
  }

  const liquidity = await getLiquidity(mintAddress);
  const authority = await hasMintAuthority(mintAddress);
  const concentration = await getTopHoldersConcentration(mintAddress);

  logger.info(
    `New Mint:\n  Address=${mintAddress}\n  Liquidity=${liquidity}\n  HasAuthority=${authority}\n  TopHolders=${concentration.toFixed(
      2
    )}%`
  );
};

export async function fetchNonCirculatingAccounts(): Promise<PublicKey[]> {
  try {
    const supplyInfo = await connection.getSupply();
    const nonCirculating = supplyInfo.value.nonCirculatingAccounts.map(
      (addr) => new PublicKey(addr)
    );
    return nonCirculating;
  } catch (error: any) {
    logger.error(`Error fetching non-circulating accounts: ${error.message}`);
    return [];
  }
}

export const getCirculatingSupply = async (): Promise<number> => {
  try {
    const supplyInfo = await connection.getSupply();
    const circulating = supplyInfo.value.circulating;
    logger.info(`Circulating supply (lamports): ${circulating}`);
    return circulating;
  } catch (error: any) {
    logger.error(`Error retrieving circulating supply:`, error);
    return 0;
  }
};
