#!/usr/bin/env bash
# Vortex 中继器一键部署（服务器上运行：bash deploy.sh）
set -e

# 加载 nvm 提供的 Node 20（系统 Node 为 v12，过旧）
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 20 >/dev/null 2>&1 || true
echo "Node: $(node -v)  npm: $(npm -v)"

cd /home/ubuntu/vortex-server

echo "==> 安装依赖"
npm install --omit=dev --silent

echo "==> 校验配置"
[ -f .env ] || { echo "缺少 .env（复制 .env.example 并填写 PRIVATE_KEY / TURNSTILE_SECRET）"; exit 1; }
grep -q "PRIVATE_KEY=0x0000000000000000000000000000000000000000000000000000000000000000" .env \
  && { echo "请先在 .env 填写真实 PRIVATE_KEY"; exit 1; }

mkdir -p /home/ubuntu/logs

echo "==> 启动/重启 pm2 服务"
pm2 delete vortex-relayer 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save

echo "==> 开机自启（首次需执行一次）"
pm2 startup systemd -u ubuntu --hp /home/ubuntu 2>&1 | grep -E '^sudo' | head -1 || true

echo "==> 健康检查"
sleep 2
curl -s http://127.0.0.1:8080/health && echo "" || echo "健康检查失败，请查看 pm2 logs vortex-relayer"

echo ""
echo "==> 完成。常用命令："
echo "    pm2 logs vortex-relayer    查看日志"
echo "    pm2 restart vortex-relayer 重启"
echo "    curl https://vortexflap.fun/api/health   外网健康检查"
