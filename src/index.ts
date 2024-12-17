import { config } from './config/index';
import { logger } from './utils/logger';
import { connectDB } from './utils/connection';
import { initializeConnection } from './services/solanaService';
import { createBot } from './bots/telegramBot';

async function initiateTradingBot() {
  // Initialize Solana connection
  initializeConnection();

  // Initialize Database connection
  await connectDB();

  // Create and launch the bot
  const bot = createBot();

  await bot.api
    .setMyCommands([
      { command: 'start', description: 'Start the bot' },
      { command: 'wallet', description: 'Manage your Solana wallet' },
      { command: 'set_filters', description: 'Set token filters' },
      { command: 'show_filters', description: 'Show current filters' },
      { command: 'start_listener', description: 'Start token detection' },
      { command: 'stop_listener', description: 'Stop token detection' },
      { command: 'help', description: 'Show available commands' },
    ])
    .then(() => console.log('✅🔔 Commands are set successfully ✅🔔'));

  await bot.start();
  logger.info('🤖 Bot is up and running');
}

void initiateTradingBot();
