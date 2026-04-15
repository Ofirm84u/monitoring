module.exports = {
  apps: [{
    name: 'monitor',
    script: 'node_modules/next/dist/bin/next',
    args: 'start --port 3040',
    cwd: '/home/ofir/monitor',
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      PORT: 3040
    },
    env_file: '.env.production',
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    autorestart: true,
    max_memory_restart: '256M'
  }]
};
