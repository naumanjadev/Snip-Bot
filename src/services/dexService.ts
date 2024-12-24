import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionSignature,
  Commitment,
} from '@solana/web3.js';
import {
  createJupiterApiClient,
  QuoteGetRequest,
  SwapPostRequest,
  QuoteResponse,
  SwapResponse,
} from '@jup-ag/api';
import { logger } from '../utils/logger';

/**
 * Confirms a transaction with retries.
 * @param connection 
 * @param txid 
 * @param maxRetries 
 * @param delayMs 
 * @returns 
 */
async function confirmTransactionWithRetry(
  connection: Connection,
  txid: TransactionSignature,
  maxRetries: number = 3,
  delayMs: number = 10000
): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const confirmation = await connection.confirmTransaction(txid, 'finalized' as Commitment);
      if (confirmation.value.err) {
        logger.error(`Transaction ${txid} failed: ${JSON.stringify(confirmation.value.err)}`);
        return false;
      }
      return true;
    } catch (err: any) {
      logger.warn(`Attempt ${i + 1} to confirm transaction ${txid} failed: ${err.message}`);
      if (i < maxRetries - 1) {
        await new Promise((res) => setTimeout(res, delayMs));
      }
    }
  }
  return false;
}

/**
 * Performs a token swap using the Jupiter aggregator.
 * @param params - Parameters for the swap.
 * @returns A boolean indicating whether the swap was successful.
 */
export const swapTokens = async (params: {
  connection: Connection;
  walletKeypair: Keypair;
  sourceTokenMint: PublicKey;
  destinationTokenMint: PublicKey;
  amountInLamports: number;
}): Promise<boolean> => {
  const { connection, walletKeypair, sourceTokenMint, destinationTokenMint, amountInLamports } = params;

  try {
    // Initialize Jupiter API client
    const jupiterApi = createJupiterApiClient();

    // Prepare the quote request
    const quoteRequest: QuoteGetRequest = {
      inputMint: sourceTokenMint.toBase58(),
      outputMint: destinationTokenMint.toBase58(),
      amount: amountInLamports,
      // We won't rely solely on slippageBps; 
      // We'll let dynamic slippage and dynamic compute unit limit handle it as per reference code.
      slippageBps: 50,
    };

    logger.debug(`Jupiter Quote Request: ${JSON.stringify(quoteRequest, null, 2)}`);

    let quoteResponse: QuoteResponse | null = null;
    try {
      quoteResponse = await jupiterApi.quoteGet(quoteRequest);
    } catch (err: any) {
      logger.error(`Failed to fetch quote from Jupiter: ${err.message}`);
      if (err.response && err.response.data) {
        logger.error(`Jupiter API Error: ${JSON.stringify(err.response.data, null, 2)}`);
      }
      return false;
    }

    logger.debug(`Raw Quote Response: ${JSON.stringify(quoteResponse, null, 2)}`);

    // Check if we got a valid route
    if (!quoteResponse) {
      logger.error('No valid swap routes found for the given token pair.');
      return false;
    }

    // Prepare the swap request (using some dynamic parameters for better reliability)
    const swapRequest: SwapPostRequest = {
      swapRequest: {
        quoteResponse,
        userPublicKey: walletKeypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: {
          maxBps: 300 // maximum slippage bps set to prevent MEV or too large slippage
        },
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            maxLamports: 10000000, // 0.01 SOL max
            priorityLevel: "veryHigh",
          },
        },
      },
    };

    logger.debug(`Jupiter Swap Request: ${JSON.stringify(swapRequest, null, 2)}`);

    let swapResponse: SwapResponse | null = null;
    try {
      swapResponse = await jupiterApi.swapPost(swapRequest);
    } catch (err: any) {
      logger.error(`Failed to execute swap on Jupiter: ${err.message}`);
      if (err.response && err.response.data) {
        logger.error(`Jupiter API Error: ${JSON.stringify(err.response.data, null, 2)}`);
      }
      return false;
    }

    logger.debug(`Jupiter Swap Response: ${JSON.stringify(swapResponse, null, 2)}`);

    if (!swapResponse || !swapResponse.swapTransaction) {
      logger.error('Failed to get swap transaction from Jupiter.');
      return false;
    }

    // Deserialize the transaction
    let transaction: VersionedTransaction;
    try {
      const swapTransactionBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
      transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    } catch (err: any) {
      logger.error(`Failed to deserialize the swap transaction: ${err.message}`);
      return false;
    }

    // Sign the transaction
    transaction.sign([walletKeypair]);

    // Simulate transaction before sending
    try {
      const simulationResult = await connection.simulateTransaction(transaction, {
        replaceRecentBlockhash: true,
        commitment: "processed",
      });

      const { err, logs } = simulationResult.value;
      if (err) {
        logger.error('Transaction simulation failed:', err, logs);
        return false;
      }
    } catch (simulateErr: any) {
      logger.error(`Failed to simulate transaction: ${simulateErr.message}`);
      return false;
    }

    // Send the transaction
    let txid: string;
    try {
      txid = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true,
        maxRetries: 2,
      });
    } catch (err: any) {
      logger.error(`Failed to send transaction: ${err.message}`);
      return false;
    }

    logger.info(`Swap transaction sent. TXID: ${txid}`);

    // Confirm the transaction with retries
    const confirmed = await confirmTransactionWithRetry(connection, txid, 3, 10000);
    if (!confirmed) {
      logger.error(`Transaction ${txid} was not confirmed after multiple attempts.`);
      return false;
    }

    logger.info(`Swap successful. Transaction ID: ${txid}`);
    return true;
  } catch (error: any) {
    logger.error(`Error performing token swap: ${error.message}`, error);
    return false;
  }
};
