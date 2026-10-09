<div align="center">

<img src="./assets/logo.png" alt="Vortex" width="140" />

# VORTEX

**The Gasless Autonomous Launchpad on BSC**

*0 手续费发币 · 一次签名即上线 FLAP · 开源可验证的中继合约*

[![Website](https://img.shields.io/badge/Website-vortexflap.fun-F0B90B?style=flat-square&logo=googlechrome&logoColor=black)](https://vortexflap.fun/)
[![X](https://img.shields.io/badge/X-@Vortex__flap-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/Vortex_flap)
[![BSC](https://img.shields.io/badge/Chain-BNB%20Smart%20Chain-F0B90B?style=flat-square&logo=binance&logoColor=black)](https://bscscan.com/)
[![License](https://img.shields.io/badge/License-MIT-3DA639?style=flat-square)](./LICENSE)
[![Contract](https://img.shields.io/badge/Contract-Verified-2ea44f?style=flat-square&logo=ethereum&logoColor=white)](https://bscscan.com/address/0x217264D477fC576B2768E2EABE7e8408CB17F39F#code)

[官网](https://vortexflap.fun/) ·
[中继合约](https://bscscan.com/address/0x217264D477fC576B2768E2EABE7e8408CB17F39F#code) ·
[白皮书](./docs/%E7%99%BD%E7%9A%AE%E4%B9%A6.md) ·
[部署文档](#-快速开始)

</div>

---

## 什么是 Vortex

Vortex 是 [FLAP](https://flap.sh) 的**手续费代付网关**。创作者只要填四个字段、签一次名，Vortex 就用自有资金代付上链 Gas，把代币直接发到 FLAP —— 全程 **0 手续费、0 Gas**。

底层不自建发币逻辑，而是调用 FLAP 官方 `Portal` 合约，外加一个**开源可验证的中继合约**负责权限控制、限额与 Gas 返还。

> 相比"写死一个钱包地址"，Vortex 的中继合约源码已在 BscScan 公开验证，任何人都能审计。

---

## 两种发射模式

FLAP 的 `TokenCreated.creator` 记录的是**交易发起者**，无法用参数覆盖 —— 因此 Vortex 提供两种模式：

|  | 🕶️ 隐私发射 | 👤 自己创建 |
| :--- | :--- | :--- |
| **链上创建者** | Vortex 中继合约（你的地址不公开） | **你本人** |
| **优先买入** | ✗ | ✅ 可在创建交易中直接买入 |
| **你的成本** | **0** | 先付 Gas，**由中继合约全额返还** |
| **适用** | 想保护隐私的创作者 | 需要"创建者身份 + 抢跑"的 DEV |

---

## 架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          🕶️  隐私发射 · 0 Gas                            │
│                        创建者链上显示为 Vortex 合约                        │
└─────────────────────────────────────────────────────────────────────────┘

  创作者 ──填表+Turnstile──▶ 中继器 ──代付 Gas──▶ VortexRelayer ──▶ FLAP Portal ──▶ 代币上线
   (0 花费)                 (Node.js)            (已验证合约)         (官方协议)      flap.sh


┌─────────────────────────────────────────────────────────────────────────┐
│                       👤  自己创建 · Gas 全额返还                          │
│                        创建者链上显示为你本人                              │
└─────────────────────────────────────────────────────────────────────────┘

  创作者 ──填表+Turnstile──▶ 中继器 ──返回 calldata──▶ 创作者自己签名发交易
     ▲                       (磨盐+上传 LOGO)                  │
     │                                                        ▼
     │                                              FLAP Portal ──▶ 代币上线
     │                                                        │
     └──── 中继器校验交易合法性后，经合约把 Gas 全额退还 ◀────────┘
```

**流程说明**

1. 创作者在前端填表（名称 / 符号 / LOGO / 代币类型 / 税率 / 税收分配 / 保护期）
2. Cloudflare Turnstile 人机验证
3. **隐私发射**：中继器代付 Gas 经中继合约调用 Portal ／ **自己创建**：用户自己签名发送交易
4. 中继器校验交易合法性后，把用户垫付的 Gas **全额返还**
5. FLAP Portal 在链上部署 ERC-20 + 联合曲线，代币即刻上线交易

---

## 核心特性

| 特性 | 说明 |
| :--- | :--- |
| 🟡 **0 手续费发币** | 中继器垫付全部 Gas，创建费为 0 |
| 🔐 **开源可验证合约** | `VortexRelayer` 已 BscScan 验证，权限 + 限额 + 暂停开关 |
| 🕶️ **隐私发射** | 创建者不公开，保护 DEV 地址隐私 |
| 👤 **自己创建 + Gas 返还** | 创建者显示为自己，Gas 由合约全额退回 |
| 🎯 **优先买入** | 支持在创建交易内直接买入（`quoteAmt`） |
| 🛡️ **6 层 Gas 防护** | gasPrice / gasLimit / 单笔成本 / 最低余额 / 日预算 / 元数据长度 |
| 🖼️ **LOGO 上链** | 图片与元数据经 FLAP IPFS 固定，前端正确显示封面 |
| 📊 **实时看板 + 荣誉墙** | 发射记录与捐赠者公开可见（链上可查） |
| 📈 **90+ 股票代币计价池** | 支持以 NVDAB / QQB / XAUT 等计价（链上化推进中） |

---

## 快速开始

### 前端（静态站点）

```bash
python -m http.server 8765
# 打开 http://127.0.0.1:8765/preview/
```

### 中继器

```bash
cd server
npm install
cp .env.example .env      # 填写 RPC / PRIVATE_KEY / TURNSTILE_SECRET
node relayer.js           # 默认 8080
```

生产部署（pm2）：

```bash
cd server
bash deploy.sh            # 装依赖 + pm2 启动 + 健康检查
pm2 logs vortex-relayer
```

### 环境变量

| 变量 | 说明 |
| :--- | :--- |
| `RPC_URLS` | BSC RPC（逗号分隔多个，自动容错） |
| `PRIVATE_KEY` | 热钱包私钥（代付 Gas / 执行返还） |
| `TURNSTILE_SECRET` | Cloudflare Turnstile 密钥 |
| `PORTAL_ADDRESS` | FLAP Portal 地址（主网 `0xe2cE6a…`） |
| `RELAYER_CONTRACT` | Vortex 中继合约地址 |
| `MAX_GAS_PRICE_GWEI` | gasPrice 上限（默认 5） |
| `MAX_COST_PER_LAUNCH_BNB` | 单笔成本上限（默认 0.005） |
| `DAILY_BUDGET_BNB` | 每日代付预算（默认 0.1） |

---

## 已部署（BSC 主网）

| 组件 | 地址 / 状态 |
| :--- | :--- |
| 中继合约 | [`0x217264D477fC576B2768E2EABE7e8408CB17F39F`](https://bscscan.com/address/0x217264D477fC576B2768E2EABE7e8408CB17F39F#code) ✅ 已验证 |
| FLAP Portal | `0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0` |
| 网站 | https://vortexflap.fun/ |

---

## 目录结构

```
vortex/
├── preview/              # 前端静态站点（4 个页面）
│   ├── index.html        #   首页：发币卡 + 实时看板
│   ├── donate.html       #   捐赠页 + 荣誉墙
│   ├── token.html        #   代币详情页
│   └── docs.html         #   白皮书
├── components/           # Next.js 组件（LaunchCard / DonateCard / Providers）
├── server/               # 中继器（代付网关）
│   ├── relayer.js        #   主服务
│   ├── deploy.sh         #   一键部署
│   ├── ecosystem.config.cjs
│   └── *.js              #   测试 / 验证脚本
├── contracts/
│   ├── VortexRelayer.sol #   ✅ 中继合约（已部署 + 验证）
│   └── VortexFactory.sol #   早期自有方案（已停用，技术备档）
├── docs/
│   ├── 白皮书.md
│   └── 捐赠文案.md
└── assets/logo.png
```

---

## 安全

- **密钥隔离**：真实私钥仅存于服务器 `.env`（权限 600），从不进入版本库
- **合约权限**：中继合约仅授权 operator 可触发发射，含单笔限额与暂停开关
- **防刷单**：Turnstile 人机验证 + IP / 钱包双维度限流（仅在发币成功时计数）
- **Gas 防护**：网络拥堵时直接拒绝代付，避免热钱包被高价 Gas 掏空
- **返还校验**：Gas 返还前校验「交易发起者 + 目标合约 + 创建者归属 + 防重复」

> ⚠️ 合约已通过 BscScan 源码验证，但**尚未经过第三方安全审计**。上主网前请自行评估风险。

---

## License

[MIT](./LICENSE)

<div align="center">
<sub>Vortex — Zero Fee. Launch on FLAP.</sub>
</div>
