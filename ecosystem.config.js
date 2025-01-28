module.exports = {
  apps: [
    {
      name: "solana-trading-bot",
      script: "dist/index.js",
      cwd: "./",
      watch: false,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "3584M", 
      env: {
        NODE_ENV: "production",
        UV_THREADPOOL_SIZE: 2,
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "logs/pm2-error.log",
      out_file: "logs/pm2-out.log",
      merge_logs: true,
    },
  ],
};
