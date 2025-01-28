module.exports = {
  apps: [
    {
      name: "solana-trading-bot", // Name of the application
      script: "dist/index.js",     // Path to the compiled JavaScript file
      cwd: "./",                   // Current working directory
      watch: false,                // Disable file watching for production
      instances: 1,                // Only one instance
      exec_mode: "fork",           // Fork mode
      autorestart: true,           // Automatically restart on crash
      max_memory_restart: "3.5G",  // Correct format for memory limit (3.5 GB)
      env: {
        NODE_ENV: "production",    // Environment configuration
        UV_THREADPOOL_SIZE: 2,     // Use both CPU cores for thread pooling
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss", // Log timestamp format
      error_file: "logs/pm2-error.log",       // Path for error logs
      out_file: "logs/pm2-out.log",           // Path for output logs
      merge_logs: true,            // Merge logs from all instances
    },
  ],
};
