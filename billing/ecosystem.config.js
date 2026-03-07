module.exports = {
  apps: [{
    name: 'billing',
    script: 'npm',
    args: 'start',
    cwd: '/opt/immutable-health-billing',
    env: {
      NODE_ENV: 'production',
      PORT: 3002
    },
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M'
  }]
}
