module.exports = {
  apps: [
    {
      name: 'sturm',
      cwd: __dirname,
      script: 'npx',
      args: 'tsx src/server.ts',
      env: {
        NODE_ENV: 'production',
        PORT: 7800,
      },
      max_memory_restart: '1G',
      out_file: './logs/sturm.out.log',
      error_file: './logs/sturm.err.log',
      merge_logs: true,
      time: true,
      // .env wird via start.sh gesourced; wenn direkt über PM2 gestartet,
      // setze MISTRAL_API_KEY / ANTHROPIC_API_KEY über `pm2 set` oder hier.
    },
  ],
};
