// src/services/solanaListener.ts

import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config';
import { logger } from '../utils/logger';
import { applyFilters } from './tokenFilters';
import { TokenInfo } from '../types';
import { purchaseToken } from './purchaseService';
import { botInstance } from '../bots/telegramBot'; // Import the exported bot instance
import axios from 'axios';
import { fetchTokenMetadata } from './tokenMetadataService'; // Import the metadata fetcher

export const connection: Connection = new Connection(config.solanaRpcUrl, 'confirmed');

let listenerId: number | null = null;
const activeUserIds: Set<number> = new Set();
let isProcessing: boolean = false; // Flag to prevent concurrent processing

// DexScreener API Endpoint
const DEXSCREENER_TOKENS_URL = 'https://api.dexscreener.com/latest/dex/tokens/';

/**
 * Fetch detailed token information from DexScreener.
 * @param tokenAddress The mint address of the token.
 * @returns Token details or null if fetching fails.
 */
const fetchTokenDetails = async (tokenAddress: string): Promise<any | null> => {
  try {
    const response = await axios.get(`${DEXSCREENER_TOKENS_URL}${tokenAddress}`);
    if (response.status === 200) {
      logger.debug(
        `DexScreener API Response for ${tokenAddress}: ${JSON.stringify(
          response.data,
          null,
          2
        )}`
      );
      return response.data;
    } else {
      logger.error(
        `DexScreener API responded with status ${response.status} for token ${tokenAddress}.`
      );
      return null;
    }
  } catch (error) {
    logger.error(
      `Error fetching token details from DexScreener for ${tokenAddress}: ${
        (error as Error).message
      }`
    );
    return null;
  }
};

/**
 * Constructs a detailed and catchy message with token information.
 * @param tokenInfo Basic token information.
 * @param dexData Detailed token information from DexScreener.
 * @returns Formatted message string.
 */
const constructTokenMessage = async (
  tokenInfo: TokenInfo,
  dexData: any
): Promise<string> => {
  const tokenAddress = tokenInfo.mintAddress;

  // Log the DexScreener data structure
  logger.debug(`Constructing message with DexScreener data: ${JSON.stringify(dexData, null, 2)}`);

  // Adjust access based on DexScreener's response structure
  const pairs = dexData.pairs || dexData.data?.pairs;

  if (pairs && pairs.length > 0) {
    const tokenDetails = pairs[0];
    const baseToken = tokenDetails.baseToken || {};
    const quoteToken = tokenDetails.quoteToken || {};
    const priceUsd = tokenDetails.priceUsd
      ? parseFloat(tokenDetails.priceUsd).toFixed(6)
      : 'N/A';
    const liquidity = tokenDetails.liquidity?.usd
      ? parseFloat(tokenDetails.liquidity.usd).toLocaleString()
      : 'N/A';
    const fdv = tokenDetails.fdv
      ? parseFloat(tokenDetails.fdv).toLocaleString()
      : 'N/A';
    const marketCap = tokenDetails.marketCap
      ? parseFloat(tokenDetails.marketCap).toLocaleString()
      : 'N/A';
    const dexUrl =
      tokenDetails.url || `https://dexscreener.com/solana/${tokenAddress}`;
    const creationTime = tokenDetails.creationTime
      ? new Date(tokenDetails.creationTime * 1000).toUTCString()
      : 'N/A';

    return `🚀 <b>🔥 New Token Alert!</b>

<b>Token Name:</b> ${baseToken.name || 'N/A'}
<b>Symbol:</b> ${baseToken.symbol || 'N/A'}
<b>Mint Address:</b> <code>${tokenAddress}</code>

🌐 <b>Blockchain:</b> Solana

💲 <b>Price USD:</b> $${priceUsd}
💧 <b>Liquidity USD:</b> $${liquidity}
📈 <b>FDV:</b> $${fdv}
📊 <b>Market Cap:</b> $${marketCap}
🕒 <b>Creation Time:</b> ${creationTime}

🔗 <b>DexScreener URL:</b> <a href="${dexUrl}">View on DexScreener</a>
🔗 <b>SolScan URL:</b> <a href="https://solscan.io/token/${tokenAddress}">View on SolScan</a>

💥 <i>This token has passed all your filters!</i>

➡️ <b>Buying Token...</b>

🔔 To listen for more tokens, use /start_listener.
`;
  } else {
    // DexScreener does not have pairs data; fetch token metadata
    const metadata = await fetchTokenMetadata(tokenAddress);
    const name = metadata?.name || 'N/A';
    const symbol = metadata?.symbol || 'N/A';

    if (name === 'N/A' && symbol === 'N/A') {
      // Both DexScreener and Metaplex failed to provide details
      return `🚨 <b>Token Match Found!</b>

<b>Mint Address:</b> <code>${tokenAddress}</code>

🔗 <a href="https://solscan.io/token/${tokenAddress}">View on SolScan</a>

💡 <i>Additional details are unavailable.</i>

💰 <b>Buying Token...</b>

🔔 To listen for more tokens, use /start_listener.
`;
    }

    return `🚨 <b>Token Match Found!</b>

<b>Token Name:</b> ${name}
<b>Symbol:</b> ${symbol}
<b>Mint Address:</b> <code>${tokenAddress}</code>

🔗 <a href="https://solscan.io/token/${tokenAddress}">View on SolScan</a>

💡 <i>Additional details are unavailable.</i>

💰 <b>Buying Token...</b>

🔔 To listen for more tokens, use /start_listener.
`;
  }
};

/**
 * Starts the token listener for a specific user.
 */
export const startTokenListener = async (userId: number): Promise<void> => {
  if (activeUserIds.has(userId)) {
    logger.warn(`Token detection is already active for user ${userId}.`);
    return;
  }

  activeUserIds.add(userId);
  logger.info(`User ${userId} started token detection.`);

  if (listenerId === null) {
    listenerId = connection.onProgramAccountChange(
      new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      async (keyedAccountInfo, context) => {
        if (isProcessing) {
          logger.debug('Listener is already processing an event. Skipping this event.');
          return;
        }

        if (activeUserIds.size === 0) {
          logger.debug('No active users. Listener should be stopped.');
          return;
        }

        isProcessing = true; // Acquire the processing lock

        try {
          const accountId = keyedAccountInfo.accountId.toBase58();
          const tokenInfo: TokenInfo = { mintAddress: accountId };
          
          // Create a snapshot of activeUserIds to allow safe removal during iteration
          const users = Array.from(activeUserIds);

          for (const uid of users) {
            try {
              const passesFilters = await applyFilters(tokenInfo, uid);
              if (passesFilters) {
                logger.info(
                  `Token ${accountId} passed filters for user ${uid}. Fetching details and sending message.`
                );

                // Fetch detailed token information from DexScreener
                const dexData = await fetchTokenDetails(accountId);

                // Log DexScreener data for debugging
                if (dexData) {
                  logger.debug(
                    `DexScreener Data for ${accountId}: ${JSON.stringify(
                      dexData,
                      null,
                      2
                    )}`
                  );
                }

                // Construct the detailed message
                const message = await constructTokenMessage(tokenInfo, dexData);

                // Send the message to the user via Telegram
                await botInstance.api.sendMessage(uid, message, { parse_mode: 'HTML' });

                // Perform the token purchase
                const purchaseSuccess = await purchaseToken(uid, tokenInfo);

                if (purchaseSuccess) {
                  // Stop the listener for this user
                  activeUserIds.delete(uid);
                  logger.info(`Listener stopped for user ${uid} after token match.`);
                }
              } else {
                logger.debug(
                  `Token ${accountId} did not pass filters for user ${uid}.`
                );
              }
            } catch (error) {
              logger.error(
                `Error processing token ${accountId} for user ${uid}: ${
                  (error as Error).message
                }`
              );
            }
          }

          // After processing all users, check if listener should be removed
          if (activeUserIds.size === 0 && listenerId !== null) {
            try {
              connection.removeProgramAccountChangeListener(listenerId);
              logger.info('Solana token listener stopped as there are no active users.');
              listenerId = null;
            } catch (error) {
              logger.error(`Error stopping token listener: ${(error as Error).message}`);
            }
          }
        } catch (error) {
          logger.error(`Unexpected error in listener callback: ${(error as Error).message}`);
        } finally {
          isProcessing = false; // Release the processing lock
        }
      },
      'confirmed' // Ensure the commitment level is appropriate
    );

    logger.info('Solana token listener started.');
  }
};

/**
 * Stops the token listener for a specific user.
 */
export const stopTokenListener = async (userId: number): Promise<void> => {
  if (!activeUserIds.has(userId)) {
    logger.warn(`Token detection is not active for user ${userId}.`);
    return;
  }

  activeUserIds.delete(userId);
  logger.info(`User ${userId} stopped token detection.`);

  if (activeUserIds.size === 0 && listenerId !== null) {
    try {
      connection.removeProgramAccountChangeListener(listenerId);
      logger.info('Solana token listener stopped.');
      listenerId = null;
    } catch (error) {
      logger.error(`Error stopping token listener: ${(error as Error).message}`);
    }
  }
};
