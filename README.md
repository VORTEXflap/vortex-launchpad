# Vortex — FLAP 手续费代付网关（The FLAP Fee-Sponsor Launchpad on BSC）

📄 **[白皮书（中文）](docs/白皮书.md)** — 平台机制、VX 平台代币经济模型。
核心经济模型：平台代币 VX 的交易税费注入发射金库，用作代付全平台在 FLAP 上的发射手续费。

## 业务模型

```
用户 ──填表──▶ Vortex 前端 ──Turnstile──▶ Vortex 中继器（热钱包）
                                              │ 代付创建费（约 0.001 BNB）
                                              │ 调 FLAP Portal newTokenV6()
                                              ▼
                              代币上线 FLAP：https://flap.sh/bnb/{token}
```

Vortex 是 **FLAP 的手续费代付层**：用户 0 手续费发币，Vortex 用自有热钱包代付
FLAP 创建费并代为上链，代币最终在 FLAP 上线交易。Vortex 的收入来自平台代币
VX 的税费（白皮书第六章），注入发射金库用于持续垫付。

## FLAP 集成要点（官方 Token Launcher Developers 文档）

| 项 | 值 |
| --- | --- |
| Portal（主网） | `0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0` |
| Portal（测试网） | `0x5bEacaF7ABCbB3aB280e80D007FD31fcE26510e9` |
| Tax Token V3 Impl（主网） | `0x024f18294970B5c76c0691b87f138A0317156422` |
| 发射函数 | `newTokenV6(NewTokenV6Params) payable returns (address)` |
| 盐锁定 | `lockSalt(bytes32 salt, TokenVersion)`（保留 CA） |
| 地址后缀 | CREATE2 磨盐：税收代币 `7777`、标准代币 `8888` |
| 创建费 | 约 0.001 BNB（以链上 `InsufficientCreationFee` 校验为准） |
| 平台费 | 曲线阶段 1%/笔（BNB 链），税收代币协议费率 ≤0.3% |
| 元数据 | `https://funcs.flap.sh/api/upload`（必须经此固定，否则 indexer 抓不到） |
| 事件 | `TokenCreated(ts, creator, nonce, token, name, symbol, meta)` |

### ✅ 已验证（2026-10-08，测试网 eth_call 模拟实测）

| 项 | 结果 |
| --- | --- |
| Portal 合约地址 | ✅ 测试网 `0x5bEaca…` 链上存在（getCode 非空） |
| ABI 字段类型 | ✅ 按官方文档修正（dexThresh/extensionID/dexId/时长字段类型），模拟调用成功执行到业务逻辑 |
| 枚举值 | ✅ `TOKEN_TAXED_V3=6`、`TOKEN_V2_PERMIT=2`、`V2_MIGRATOR=1` |
| 磨盐算法 | ✅ 预测地址 = Portal 实际返回地址，税收代币后缀 `7777` 命中 |
| dexThresh | ✅ 测试网税收代币仅接受 `1`（FOUR_FIFTHS，80% 毕业线），已固化 |
| quoteAmt=0（不代买） | ✅ `value=0.001 BNB` 纯付创建费发射成功 |
| SALT_LOCK_FEE | ✅ 链上实测 = 0.01 BNB（保留 CA 盐锁定费） |
| 创建费 | 测试网实测为 0；主网按约 0.001 BNB 预算（`CREATION_FEE` 可调） |

### ✅ 真实发币验证记录（2026-10-09，BSC 测试网实测）

首次真实上链成功，端到端链路（磨盐 → 代付 → Portal → 事件解析）全部验证：

| 项 | 值 |
| --- | --- |
| 代币地址 | `0x1A35b7b8efBC80390D63651C2F09b75b4a297777`（后缀 7777，与 CREATE2 预测一致） |
| 交易 | `0xa97caa2a055cc836b93496bd39e968d425cae1ac772a0ae1c22a5ed6efd43ff4` |
| 链上元数据 | 名称 Vortex Test Token / 符号 VTEST / 供应量 1e9 |
| Gas | 3,560,533（约 0.00036 BNB）+ 创建费，单笔约 0.0014 BNB |
| Turnstile | Site Key + Secret 双端已配，校验实测生效（假 token 被拒） |

**真发币才会暴露的两个坑（已修，务必保留）**：

1. **`taxDuration` 不能为 0** —— 税收代币的税收持续时间设为 0 会被 Portal revert
   （`estimateGas` 直接失败）。现固定 365 天。
2. **`TokenCreated` 事件没有 `indexed` 修饰符** —— 这是最隐蔽的坑：
   `indexed` **不影响事件签名哈希**（所以 `topics[0]` 能匹配上），
   但会让实际 `topics` 数量（1 个）与 ABI 假设（3 个）不符，
   导致 `parseLog` 抛 `data out-of-bounds`。ABI 必须写成全非 indexed。

### ✅ 代币 LOGO / 元数据上传（已实现并验证）

代币封面走 FLAP 官方 IPFS 上传接口（GraphQL multipart 规范）：

```
前端上传 LOGO → dataURL 提交后端 → 后端 POST https://funcs.flap.sh/api/upload
  （form: operations + map + 文件）→ 返回 CID → 作为 newTokenV6 的 meta 参数
```

实测：CID `bafkreihd7lt7fe2ytjqhsqhcwrje2bmso7kaii65prii62z7qdvwns4c3i`，
代币 `0xbE653DCa25af8B084C9533f6F026D92cf3A37777` 成功带图上线。

- 必须经该接口上传并 pin，否则 FLAP 索引器抓不到封面。
- 图片上限 1.5MB（前端与后端双重校验）。
- 上传失败不阻断发币（meta 退化为空字符串）。

### 两种发射模式

FLAP 的 `TokenCreated.creator` 记录的是**发起交易者**，无法用参数覆盖——因此设计了两种模式：

| 模式 | 名称 | 创建者链上显示 | 优先买入 | 用户成本 | 接口 |
| --- | --- | --- | --- | --- | --- |
| A | **隐私发射** | Vortex 中继合约（用户地址不公开） | ✗ | 0 | `POST /api/launch` |
| B | **自己创建** | **用户本人** ✓ | ✅ 可带 `quoteAmt` 创建即买入 | 先付 gas，**全额返还** | `POST /api/prepare` + `POST /api/refund` |

**自己创建模式流程**（`/api/prepare` → 用户签名发交易 → `/api/refund`）：

```
1. 前端调 /api/prepare  → 后端磨盐 + 上传 LOGO 到 IPFS，返回 calldata
2. 用户钱包签名发送该交易（to=Portal, value=quoteAmt）→ 创建者=用户本人
3. 前端轮询确认后调 /api/refund → 后端校验（交易合法 + creator 归属 + 防重复）
   → 经中继合约 refundGas(user, txHash) 携带 value 转发 → 链上 GasRefunded 事件
```

链路校验防止滥用：`tx.from == 用户` + `tx.to == Portal` + 交易含 `TokenCreated` +
`creator == 用户` + `refunded[txHash] == false` + 单笔上限 `MAX_REFUND_BNB`。

### 中继合约（VortexRelayer）

对外展示的**链上可验证发射入口**：热钱包(EOA, 付 gas) → 中继合约 → FLAP Portal。

```
contracts/VortexRelayer.sol   已部署: 0x217264D477fC576B2768E2EABE7e8408CB17F39F
```

- **权限控制**：只有 owner 授权的 operator（热钱包）可触发发射
- **限额**：`maxValuePerLaunch` = 0.01 BNB；`paused` 可紧急暂停
- **事件**：`LaunchSponsored(token, creator, operator, value, ts)` 上链，看板可据此索引
- **代币归属**：`beneficiary` 强制为参数指定地址（真实创建者）
- 关闭方式：`.env` 留空 `RELAYER_CONTRACT=` 即回退为直接调 Portal

**BscScan 源码验证** ✅ 已完成（2026-10-09）：

| 项 | 值 |
| --- | --- |
| 合约地址 | `0x217264D477fC576B2768E2EABE7e8408CB17F39F` |
| 验证状态 | **Pass - Verified** |
| 编译器 | solc `0.8.24+commit.e11b9ed9` |
| 优化 | Enabled, Runs = `200` |
| EVM 版本 | `shanghai`（solc 0.8.24 默认；填错会导致字节码不匹配） |
| License | MIT |

> ⚠️ 重验证要点：Etherscan V2 API（`api.etherscan.io/v2/api?chainid=56`）的**免费额度不支持 stats 端点**，
> 但 `contract` 模块可用（免费）。提交时 `constructorArguements` 必须严格 192 字符（ABI 编码去 0x 前缀）。
| 构造参数 | `000000000000000000000000e2ce6ab80874fa9fa2aae65d277dd6b8e65c9de00000000000000000000000004ed1d87e269f7f5a4490d66372514206b9d34a0b000000000000000000000000000000000000000000000000002386f26fc10000` |

### ⚠ 剩余检查单

1. **真实交易**：模拟已通过，但还需一笔真实测试网交易（热钱包有测试 BNB +
   Turnstile 配置）端到端跑通（`server/simulate-launch.js` 可复现模拟）；
2. **元数据上传**：按 FLAP 文档实现 GraphQL `create(file, meta)` multipart 上传
   （当前为占位实现，失败不阻断但 indexer 无法抓取）；
3. **主网参数复核**：主网 Portal 的 dexThresh 支持范围、创建费精确值需按主网实测；
4. **授权模型**：当前假设 Portal 允许任意地址代发（`beneficiary` 指向用户）——测试网
   模拟已证实此假设成立，主网部署需再次确认 `permitData` 是否被强制要求。

## 文件

| Path | Role |
| --- | --- |
| `server/relayer.js` | FLAP 代付网关：Turnstile、限流、磨盐、代付创建费、调 Portal、解析 TokenCreated、`/api/fund` 基金地址 |
| `components/LaunchCard.tsx` | Next.js 前端：表单（名称/符号/描述/Logo/模式/税率/分配/保护期）→ 代付网关 → FLAP 链接 |
| `preview/index.html` | 独立演示站（`python -m http.server 8765` 后打开 `http://127.0.0.1:8765/preview/`） |
| `docs/白皮书.md` | 平台白皮书（VX 经济模型） |
| `contracts/VortexFactory.sol` | ⚠ 早期「自有发射合约」方案，已停用（保留作技术备档） |

## 线上部署状态（vortexflap.fun）

| 项 | 状态 |
| --- | --- |
| 站点 | **https://vortexflap.fun/** （www 同域，HTTP 自动跳 HTTPS） |
| 静态文件 | 服务器 `/var/www/auton/vortex/`（www-data 属主） |
| HTTPS | Let's Encrypt 证书，有效期至 2027-01-06，certbot 每日自动续期 |
| nginx | 已启用并开机自启；站点配置 `/etc/nginx/sites-available/vortexflap` |
| API 反代 | ✅ `https://vortexflap.fun/api/` → `127.0.0.1:8080`（已配置并验证） |
| 中继器后端 | ✅ 已启动（pm2 `vortex-relayer`，开机自启 enabled） |
| 旧链接兼容 | ✅ `/vortex/*` → 301 重定向到根路径（修复早期链接破图/路由错乱） |
| 热钱包 | `0x4ED1d87e269f7f5A4490d66372514206b9d34A0B`（主网余额需持续补充） |
| **中继合约** | **`0x217264D477fC576B2768E2EABE7e8408CB17F39F`** ✅ **BscScan 源码已验证**（VortexRelayer v2，含 Gas 返还） |
| 当前网络 | ✅ **BSC 主网**（chainId 56，Portal `0xe2cE6a…`，创建费 0） |
| Turnstile | Site Key 已接入前端（懒加载）；⚠️ **Secret Key 待配置** |
| Node 环境 | 服务器系统 Node v12 过旧，已用 nvm 装 **Node 20.20.2** 隔离运行 |

### Gas 防护（防恶意拉高 Gas 掏空热钱包）

`server/.env` 中 6 层限制，任一项超限即拒绝且不发交易：

| 配置项 | 默认值 | 作用 |
| --- | --- | --- |
| `MAX_GAS_PRICE_GWEI` | 5 | gasPrice 上限，网络拥堵时拒绝（不高价硬付） |
| `MAX_GAS_LIMIT_STR` | 12000000 | 单笔 gasLimit 硬上限（FLAP 税收代币主网实测需 6.6M，测试网仅 3.6M） |
| `MAX_COST_PER_LAUNCH_BNB` | 0.005 | 单笔总成本上限（gas + 创建费） |
| `MIN_WALLET_BALANCE_BNB` | 0.01 | 热钱包最低保留余额 |
| `DAILY_BUDGET_BNB` | 0.1 | 每日代付总支出上限（防多钱包绕过限流） |
| `MAX_META_LEN` | 300 | 元数据长度上限（防超长参数推高存储 Gas） |

另有**磨盐互斥锁**：磨盐是 CPU 密集操作（最坏 50 万次 keccak256），同一时刻仅允许一次，防并发打满 CPU。

### 前端实现要点

- **API 基址自动推断**：线上同域 `/api/`，本地 `localhost:8080`，部署后端无需改前端。
- **Turnstile 懒加载**：页面加载时零 Cloudflare 请求（避免国内网络拖慢页面），点击发币才加载。
- **输入框配色**：`#131518` 背景 + 悬停边框反馈（暗色主题下明确"可输入"）。

前端 API 基址自动推断（`preview/*.html` 中的 `API_BASE`）：线上同域走 `/api/`，
本地开发走 `localhost:8080`，**部署后端后前端无需改动**。

### 上线发币功能（替换密钥即可）

中继器已部署运行，只读接口（看板/荣誉墙/基金地址）已通。要启用**真实发币**，替换密钥：

```bash
# 服务器上
cd /home/ubuntu/vortex-server
nano .env      # 填真实 PRIVATE_KEY（热钱包，需有 BNB）与 TURNSTILE_SECRET
bash deploy.sh # 重装依赖并重启 pm2
```

### 从零部署中继器（三步）

```bash
# 1. 填配置（服务器上）
cd /home/ubuntu/vortex-server
cp .env.example .env && nano .env      # 必填：PRIVATE_KEY、TURNSTILE_SECRET
                                       # 可选：FUND_ADDRESS（捐赠收款，建议多签）

# 2. 一键部署（装依赖 + pm2 启动 + 健康检查）
bash deploy.sh

# 3. 查看日志
pm2 logs vortex-relayer
```

### 本地开发

```bash
cd server && npm install
cp .env.example .env        # 填 PRIVATE_KEY / TURNSTILE_SECRET
node relayer.js             # 默认 8080；可用 simulate-launch.js 做发射模拟测试
```

静态预览站：仓库根目录 `python -m http.server 8765`，访问 `http://127.0.0.1:8765/preview/`。

# 前端（Next.js 14）
npm i wagmi viem @tanstack/react-query @reown/appkit @reown/appkit-adapter-wagmi @marsidev/react-turnstile
# 钱包连接使用 Reown AppKit（WalletConnect 扫码 + 插件钱包），
# 到 https://cloud.reown.com 免费注册拿 Project ID：
#   NEXT_PUBLIC_REOWN_PROJECT_ID=xxx（.env.local）
#   NEXT_PUBLIC_RELAYER_URL=http://localhost:8080
#   NEXT_PUBLIC_FUND_ADDRESS=0x...（开发者互助基金收款地址）
#   NEXT_PUBLIC_TURNSTILE_SITE_KEY=0x...
# 布局中包裹 <Providers>（见 components/Providers.tsx），页面渲染 <LaunchCard/>。
```

## UI 设计（参考 FLAP）

视觉语言参考 [flap.sh](https://flap.sh/launch)：近黑背景 `#070808`、主色
`--vortex-accent`（默认项目 LOGO 金色 `#E0A000`，可一行切回柠檬绿/币安黄）、
`#303236` 描边黑底按钮、Noto Sans SC + Space Grotesk 字体。版式：顶部导航 →
英雄区（`/// Zero Fee. Launch on FLAP.`）→ 左侧发币卡（基本信息 / 发射模式 /
支付代币 / 代币设置：税率、税收分配、防挖提卖保护期）+ 右侧 FLAP 式实时看板
（分类标签、列表/网格切换、股票底池 90+ 池）。
