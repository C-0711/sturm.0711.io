module.exports = {
  apps: [
    {
      name: 'sturm',
      cwd: __dirname,
      script: './start.sh',
      interpreter: 'bash',
      env: {
        NODE_ENV: 'production',
        PORT: 7800,
      },
      max_memory_restart: '1G',
      out_file: './logs/sturm.out.log',
      error_file: './logs/sturm.err.log',
      merge_logs: true,
      time: true,
      // start.sh sourced .env (lokal oder Fallback aus cb-ctax), damit
      // MISTRAL_API_KEY / ANTHROPIC_API_KEY automatisch gesetzt sind.
    },
  ],
};
