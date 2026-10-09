// pm2 部署配置：pm2 start ecosystem.config.cjs
module.exports = {
  apps: [{
    name: "vortex-relayer",
    script: "relayer.js",
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    max_memory_restart: "300M",
    env: { NODE_ENV: "production" },
    error_file: "/home/ubuntu/logs/vortex-relayer.err.log",
    out_file: "/home/ubuntu/logs/vortex-relayer.out.log",
    time: true,
  }],
};
