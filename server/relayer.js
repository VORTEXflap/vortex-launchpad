/**
 * Vortex Relayer — FLAP 手续费代付网关
 *
 * 业务模型：用户经 Vortex 前端填表，Vortex 热钱包代付 FLAP 创建手续费
 * （约 0.001 BNB/次，以链上 InsufficientCreationFee 校验为准）并调用
 * FLAP Portal 的 newTokenV6() 发射代币——代币最终上线 FLAP：
 * https://flap.sh/bnb/{token}
 *
 * 集成依据（FLAP 官方 Token Launcher Developers 文档）：
 *   Portal 主网 0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0
 *   Portal 测试网 0x5bEacaF7ABCbB3aB280e80D007FD31fcE26510e9
 *   Tax Token V3 Impl 主网 0x024f18294970B5c76c0691b87f138A0317156422
 *   曲线阶段平台费 1%（BNB 链），税收代币协议费率 ≤0.3%
 *
 * ⚠ 上线前必须完成（见 README「FLAP 集成检查单」）：
 *   1. 用 BSCscan 验证 Portal 源码核对 NewTokenV6Params 字段顺序与枚举值；
 *   2. 在测试网实测创建费精确值与盐计算后缀规则（税收代币 7777）；
 *   3. 按 FLAP 文档实现元数据上传（funcs.flap.sh/api/upload）。
 */
"use strict";

require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const { ethers } = require("ethers");

const {
  RPC_URL, // BSC RPC（测试网: https://data-seed-prebsc-1-s1.binance.org:8545）
  PRIVATE_KEY, // Vortex 热钱包（代付 FLAP 创建费）
  TURNSTILE_SECRET, // Cloudflare Turnstile secret
  PORTAL_ADDRESS = "0x5bEacaF7ABCbB3aB280e80D007FD31fcE26510e9", // 默认 FLAP 测试网 Portal
  RELAYER_CONTRACT = "", // Vortex 中继合约（配置后经合约发币，对外展示合约身份）
  TAX_IMPL = "0xE6Ff967a887084c16D0fD71548CF709542cc1557", // 测试网 Tax V3 Impl（盐计算用）
  STANDARD_IMPL = "0x87D5f292ba33011997641C7a7Bd2b17799aaA814", // 测试网 Standard Impl（盐计算用）
  CREATION_FEE = "1000000000000000", // 0.001 BNB；测试网实测创建费为 0，此值作为主网安全余量
  METADATA_API = "https://funcs.flap.sh/api/upload",
  FUND_ADDRESS, // 开发者互助基金收款地址（默认 = 热钱包；建议独立冷钱包/多签）
  PORT = 8080,
  CORS_ORIGIN = "*",
  // ===== Gas 防护（防恶意拉高 Gas 掏空热钱包）=====
  MAX_GAS_PRICE_GWEI = "5",          // gasPrice 上限，超过直接拒绝（网络拥堵时不硬付）
  MAX_GAS_LIMIT_STR = "3500000",     // 单笔 gasLimit 硬上限
  MAX_COST_PER_LAUNCH_BNB = "0.005", // 单笔总成本上限（gas + 创建费）
  MIN_WALLET_BALANCE_BNB = "0.01",   // 热钱包最低保留余额（低于则停止服务）
  DAILY_BUDGET_BNB = "0.1",          // 每日代付总支出上限
  MAX_META_LEN = "300",              // 元数据字符串长度上限（防超长参数推高存储 Gas）
  MAX_REFUND_BNB = "0.01",           // 单笔 Gas 返还上限（自己创建模式）
} = process.env;

const HAS_RPC = Boolean(process.env.RPC_URLS || RPC_URL);
if (!HAS_RPC || !PRIVATE_KEY || !TURNSTILE_SECRET) {
  console.error("[relayer] Missing env: RPC_URLS(或 RPC_URL), PRIVATE_KEY, TURNSTILE_SECRET");
  process.exit(1);
}

// 多 RPC 容错：单个公共节点被限流（403）时自动切到下一个
const RPC_LIST = (process.env.RPC_URLS || RPC_URL || "").split(",").map((u) => u.trim()).filter(Boolean);
if (!RPC_LIST.length) { console.error("[relayer] 需要 RPC_URLS 或 RPC_URL"); process.exit(1); }
const provider = RPC_LIST.length > 1
  ? new ethers.FallbackProvider(
      RPC_LIST.map((url, i) => ({
        provider: new ethers.JsonRpcProvider(url),
        priority: i + 1,
        weight: 1,
        stallTimeout: 2500,
      })),
      undefined,
      { quorum: 1 }
    )
  : new ethers.JsonRpcProvider(RPC_LIST[0]);
console.log(`[relayer] RPC 节点 ${RPC_LIST.length} 个（${RPC_LIST.length > 1 ? "已启用容错" : "单点"}）`);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ⚠ 字段顺序与枚举值必须与 BSCscan 上 Portal 已验证源码核对（见文件头）
const PORTAL_ABI = [
  "function newTokenV6((string name,string symbol,string meta,uint8 dexThresh,bytes32 salt,uint8 migratorType,address quoteToken,uint256 quoteAmt,address beneficiary,bytes permitData,bytes32 extensionID,bytes extensionData,uint8 dexId,uint8 lpFeeProfile,uint16 buyTaxRate,uint16 sellTaxRate,uint64 taxDuration,uint64 antiFarmerDuration,uint16 mktBps,uint16 deflationBps,uint16 dividendBps,uint16 lpBps,uint256 minimumShareBalance,address dividendToken,address commissionReceiver,uint8 tokenVersion) params) external payable returns (address token)",
  // 实测无 indexed：indexed 不影响签名哈希，但会让 topics 数量不符导致解析失败
  "event TokenCreated(uint256 ts, address creator, uint256 nonce, address token, string name, string symbol, string meta)",
];
const portal = new ethers.Contract(PORTAL_ADDRESS, PORTAL_ABI, wallet);

// Vortex 中继合约：配置后所有发射经此合约进行（链上可验证的合约身份）
const RELAYER_ABI = [
  "function sponsorLaunch((string name,string symbol,string meta,uint8 dexThresh,bytes32 salt,uint8 migratorType,address quoteToken,uint256 quoteAmt,address beneficiary,bytes permitData,bytes32 extensionID,bytes extensionData,uint8 dexId,uint8 lpFeeProfile,uint16 buyTaxRate,uint16 sellTaxRate,uint64 taxDuration,uint64 antiFarmerDuration,uint16 mktBps,uint16 deflationBps,uint16 dividendBps,uint16 lpBps,uint256 minimumShareBalance,address dividendToken,address commissionReceiver,uint8 tokenVersion) params) payable returns (address token)",
  "event LaunchSponsored(address indexed token, address indexed creator, address indexed operator, uint256 value, uint256 ts)",
];
const relayer = RELAYER_CONTRACT ? new ethers.Contract(RELAYER_CONTRACT, RELAYER_ABI, wallet) : null;
if (relayer) console.log(`[relayer] 经中继合约发射: ${RELAYER_CONTRACT}`);

// ---------------------------------------------------------------------------
// Gas 防护：所有阈值集中在此，任一项超限即拒绝，避免热钱包被恶意掏空
// ---------------------------------------------------------------------------
const MAX_GAS_PRICE = ethers.parseUnits(MAX_GAS_PRICE_GWEI, "gwei");
const MAX_GAS_LIMIT = BigInt(MAX_GAS_LIMIT_STR);
const MAX_COST = ethers.parseEther(MAX_COST_PER_LAUNCH_BNB);
const MIN_BALANCE = ethers.parseEther(MIN_WALLET_BALANCE_BNB);
const DAILY_BUDGET = ethers.parseEther(DAILY_BUDGET_BNB);
const MAX_META_LENGTH = Number(MAX_META_LEN);

let dailySpent = 0n;
let dailyResetAt = Date.now();

/** 每日预算记账：跨天自动重置；累计超预算则拒绝 */
function chargeDailyBudget(cost) {
  const now = Date.now();
  if (now - dailyResetAt > 24 * 60 * 60 * 1000) {
    dailySpent = 0n;
    dailyResetAt = now;
  }
  if (dailySpent + cost > DAILY_BUDGET) {
    throw new Error("DAILY_BUDGET_EXCEEDED");
  }
  dailySpent += cost;
}

// 磨盐是 CPU 密集操作（最坏 50 万次 keccak256），加互斥防并发打满 CPU
let grinding = false;

// ---------------------------------------------------------------------------
// CREATE2 盐计算：FLAP 用最小代理模式部署，税收代币地址以 7777 结尾
// ---------------------------------------------------------------------------
const PROXY_BYTECODE_PREFIX = "0x3d602d80600a3d3981f3363d3d373d3d3d363d73";
const PROXY_BYTECODE_SUFFIX = "5af43d82803e903d91602b57fd5bf3";

function computeTokenAddress(salt, impl) {
  const initCode =
    PROXY_BYTECODE_PREFIX + impl.slice(2).toLowerCase() + PROXY_BYTECODE_SUFFIX;
  return ethers.getCreate2Address(PORTAL_ADDRESS, salt, ethers.keccak256(initCode));
}

/** 磨盐直到地址后缀命中（税收代币 7777 / 标准代币 8888） */
function grindSalt(impl, suffix) {
  if (grinding) throw new Error("BUSY");   // 同一时刻只允许一次磨盐
  grinding = true;
  try {
    return grindSaltInner(impl, suffix);
  } finally {
    grinding = false;
  }
}

function grindSaltInner(impl, suffix) {
  for (let i = 0; i < 500_000; i++) {
    const salt = ethers.hexlify(ethers.randomBytes(32));
    if (computeTokenAddress(salt, impl).slice(-suffix.length) === suffix) return salt;
  }
  throw new Error("SALT_GRIND_FAILED");
}

// ---------------------------------------------------------------------------
// 元数据上传（FLAP 要求经其 API 固定，否则 indexer 无法抓取）
// TODO: 按 docs.flap.sh 的 GraphQL schema（create(file, meta) multipart）实现
// ---------------------------------------------------------------------------
/**
 * 上传代币图片 + 元数据到 FLAP IPFS（GraphQL multipart 规范）
 * 依据官方文档：https://docs.flap.sh/flap/developers/token-launcher-developers/launch-token-through-portal.md
 * 返回 CID（作为 newTokenV6 的 meta 参数）；失败返回 ""（不阻断发币）
 */
async function uploadMetadata(description, logoDataUrl, creator) {
  if (!logoDataUrl || typeof logoDataUrl !== "string") return "";
  const m = logoDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
  if (!m) return "";
  const mime = m[1];
  let buf;
  try {
    buf = Buffer.from(m[2], "base64");
  } catch {
    return "";
  }
  if (buf.length === 0 || buf.length > 1_500_000) return ""; // 上限 1.5MB

  try {
    const form = new FormData();
    form.append("operations", JSON.stringify({
      query: "mutation Create($file: Upload!, $meta: MetadataInput!) { create(file: $file, meta: $meta) }",
      variables: {
        file: null,
        meta: {
          description: description || "",
          creator,
          website: null,
          twitter: null,
          telegram: null,
        },
      },
    }));
    form.append("map", JSON.stringify({ "0": ["variables.file"] }));
    form.append("0", new Blob([buf], { type: mime }), "logo.png");

    const res = await fetch(METADATA_API, { method: "POST", body: form });
    if (!res.ok) {
      console.warn("[relayer] 元数据上传失败 HTTP", res.status);
      return "";
    }
    const data = await res.json();
    const cid = data?.data?.create;
    if (typeof cid === "string" && cid) {
      console.log("[relayer] 元数据已上传 CID=" + cid);
      return cid;
    }
    return "";
  } catch (err) {
    console.warn("[relayer] 元数据上传异常:", err.message);
    return "";
  }
}

// ---------------------------------------------------------------------------
// 风控（与自有方案一致）
// ---------------------------------------------------------------------------
// 限流（可环境变量调整）；仅在**发币成功后**计数，失败不消耗额度
const IP_WINDOW_MS = Number(process.env.IP_WINDOW_MS ?? 60 * 1000); // 默认 1 分钟 1 次
const WALLET_WINDOW_MS = 24 * 60 * 60 * 1000;
const WALLET_MAX_LAUNCHES = Number(process.env.WALLET_MAX_LAUNCHES ?? 3);
const ipLastLaunch = new Map();
const walletLaunches = new Map();

/** 纯检查，不消耗额度（失败/超限的请求不应计入） */
function checkIpRate(ip) {
  const last = ipLastLaunch.get(ip) || 0;
  return Date.now() - last >= IP_WINDOW_MS;
}

function checkWalletRate(address) {
  const key = address.toLowerCase();
  const recent = (walletLaunches.get(key) || []).filter((ts) => Date.now() - ts < WALLET_WINDOW_MS);
  return recent.length < WALLET_MAX_LAUNCHES;
}

/** 仅在发币成功后调用，记录本次额度消耗 */
function recordLaunch(ip, address) {
  ipLastLaunch.set(ip, Date.now());
  const key = address.toLowerCase();
  const recent = (walletLaunches.get(key) || []).filter((ts) => Date.now() - ts < WALLET_WINDOW_MS);
  recent.push(Date.now());
  walletLaunches.set(key, recent);
}

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  return (typeof fwd === "string" ? fwd.split(",")[0].trim() : "") || req.socket.remoteAddress || "";
}

async function verifyTurnstile(token, remoteIp) {
  if (!token || typeof token !== "string") return false;
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: TURNSTILE_SECRET, response: token, remoteip: remoteIp || undefined }),
  });
  if (!res.ok) return false;
  return (await res.json()).success === true;
}

// ---------------------------------------------------------------------------
// 参数校验并映射到 FLAP NewTokenV6Params
// ---------------------------------------------------------------------------
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

function validatePayload(body) {
  if (!body || typeof body !== "object") throw new Error("INVALID_BODY");
  const { name, symbol, description, logo: _logoIn, userAddress, tokenType, buyTaxPct, sellTaxPct,
    mktPct, deflationPct, dividendPct, lpPct, taxWallet, protectSeconds, turnstileToken } = body;

  if (typeof name !== "string" || name.length < 1 || name.length > 32) throw new Error("INVALID_NAME");
  if (typeof symbol !== "string" || !/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error("INVALID_SYMBOL");
  if (typeof userAddress !== "string" || !ethers.isAddress(userAddress)) throw new Error("INVALID_ADDRESS");
  if (typeof turnstileToken !== "string" || !turnstileToken) throw new Error("INVALID_TURNSTILE");
  const desc = typeof description === "string" ? description.slice(0, 300) : ""; // 限长防存储 Gas 膨胀
  // LOGO：dataURL 形式传入，后端上传到 FLAP IPFS；限制大小防滥用
  const logo = typeof body.logo === "string" && body.logo.startsWith("data:image/") ? body.logo : "";
  if (logo.length > 2_000_000) throw new Error("LOGO_TOO_LARGE");
  const isTax = tokenType !== "standard";

  // 税率 0–10%（UI 百分比 × 100 = FLAP bps），税收模式有效
  const buyTaxRate = isTax ? Number(buyTaxPct ?? 1) * 100 : 0;
  const sellTaxRate = isTax ? Number(sellTaxPct ?? 1) * 100 : 0;
  if (buyTaxRate < 0 || buyTaxRate > 1000 || sellTaxRate < 0 || sellTaxRate > 1000) throw new Error("INVALID_TAX");

  // 分配（FLAP: mkt + deflation + dividend + lp 合计 10000）
  const mktBps = isTax ? Number(mktPct ?? 100) * 100 : 0;
  const deflationBps = isTax ? Number(deflationPct ?? 0) * 100 : 0;
  const dividendBps = isTax ? Number(dividendPct ?? 0) * 100 : 0;
  const lpBps = isTax ? Number(lpPct ?? 0) * 100 : 0;
  if (isTax && mktBps + deflationBps + dividendBps + lpBps !== 10000) throw new Error("DISTRIBUTION_MUST_SUM_100");

  const commissionReceiver = isTax && taxWallet && ethers.isAddress(taxWallet) ? taxWallet : userAddress;

  // 防挖提卖保护期 → FLAP antiFarmerDuration（秒）
  const antiFarmerDuration = Number(protectSeconds ?? 0);
  if (!Number.isInteger(antiFarmerDuration) || antiFarmerDuration < 0 || antiFarmerDuration > 30 * 24 * 3600) {
    throw new Error("INVALID_PROTECT");
  }

  return {
    name, symbol, meta: desc, logo, creator: userAddress,
    tokenVersion: isTax ? 6 : 2, // 已核对官方文档：TOKEN_TAXED_V3=6 / TOKEN_V2_PERMIT=2
    impl: isTax ? TAX_IMPL : STANDARD_IMPL,
    suffix: isTax ? "7777" : "8888",
    buyTaxRate, sellTaxRate, mktBps, deflationBps, dividendBps, lpBps,
    commissionReceiver, antiFarmerDuration,
  };
}

async function submitLaunch(params) {
  // 1) 磨盐：命中地址后缀（含并发互斥）
  const salt = grindSalt(params.impl, params.suffix);

  // 2) 元数据（失败不阻断，用空 meta 兜底；长度受限防存储 Gas 膨胀）
  const meta = await uploadMetadata(params.meta, params.logo, params.creator);
  if (meta.length > MAX_META_LENGTH) throw new Error("META_TOO_LONG");

  const fee = BigInt(CREATION_FEE);

  const args = {
    name: params.name,                 // ≤ 32（校验层已限）
    symbol: params.symbol,             // ≤ 10（校验层已限）
    meta,
    dexThresh: 1, // DexThreshType.FOUR_FIFTHS=1（80% 毕业线，测试网实测唯一支持值）
    salt,
    migratorType: params.tokenVersion === 6 ? 1 : 0, // V2_MIGRATOR=1（税收代币必须 V2）
    quoteToken: ZERO_ADDR,
    quoteAmt: 0, // 代付网关不代买，仅付创建费（quoteAmt=0 已实测通过）
    beneficiary: params.creator,
    permitData: "0x",
    extensionID: "0x" + "0".repeat(64),
    extensionData: "0x",
    dexId: 0,
    lpFeeProfile: 0,
    buyTaxRate: params.buyTaxRate,
    sellTaxRate: params.sellTaxRate,
    taxDuration: 31536000, // 税收持续 365 天（实测 0 会被合约 revert）
    antiFarmerDuration: params.antiFarmerDuration,
    mktBps: params.mktBps,
    deflationBps: params.deflationBps,
    dividendBps: params.dividendBps,
    lpBps: params.lpBps,
    minimumShareBalance: 0,
    dividendToken: ZERO_ADDR,
    commissionReceiver: params.commissionReceiver,
    tokenVersion: params.tokenVersion,
  };

  // ===== 3) Gas 防护链：任一项超限即拒绝，不发送任何交易 =====

  // 3.1 gasPrice 上限：网络拥堵时直接拒绝，绝不以高价硬付
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
  if (gasPrice == null) throw new Error("GAS_PRICE_UNAVAILABLE");
  if (gasPrice > MAX_GAS_PRICE) {
    throw new Error(`GAS_PRICE_TOO_HIGH(当前 ${ethers.formatUnits(gasPrice, "gwei")} gwei > 上限 ${MAX_GAS_PRICE_GWEI})`);
  }

  // 3.2 gasLimit：先估算（不花钱），再设硬上限，防超长参数推高 Gas
  let gasLimit;
  const target = relayer || portal;              // 有中继合约则经合约
  const method = relayer ? "sponsorLaunch" : "newTokenV6";
  try {
    const est = await target[method].estimateGas(args, { value: fee });
    gasLimit = (est * 120n) / 100n; // +20% 缓冲
  } catch (err) {
    throw new Error("GAS_ESTIMATE_FAILED:" + (err.shortMessage || err.message));
  }
  if (gasLimit > MAX_GAS_LIMIT) {
    throw new Error(`GAS_LIMIT_EXCEEDED(估算 ${gasLimit} > 上限 ${MAX_GAS_LIMIT})`);
  }

  // 3.3 单笔总成本上限（gas 成本 + 创建费）
  const gasCost = gasLimit * gasPrice;
  const totalCost = gasCost + fee;
  if (totalCost > MAX_COST) {
    throw new Error(`COST_EXCEEDED(单笔 ${ethers.formatEther(totalCost)} BNB > 上限 ${MAX_COST_PER_LAUNCH_BNB})`);
  }

  // 3.4 热钱包余额保护：付完这笔后仍需保留最低底仓
  const balance = await provider.getBalance(wallet.address);
  if (balance < totalCost + MIN_BALANCE) {
    throw new Error(`RELAYER_LOW_BALANCE(余额 ${ethers.formatEther(balance)} BNB 不足)`);
  }

  // 3.5 每日总支出上限（防多钱包绕过单钱包限流刷单）
  chargeDailyBudget(totalCost);

  // ===== 4) 发送交易：显式指定 gasPrice/gasLimit，禁止自动涨价 =====
  const txNonce = await wallet.getNonce("pending");
  const tx = await target[method](args, {
    value: fee,
    gasLimit,
    gasPrice,
    nonce: txNonce,
  });
  console.log(`[relayer] 发射中 tx=${tx.hash} via=${relayer ? "RelayerContract" : "Portal"} gasLimit=${gasLimit} gasPrice=${ethers.formatUnits(gasPrice, "gwei")}gwei`);

  // 等待回执：RPC 可能限流失败。重试多次；若始终拿不到，也**必须返回交易哈希**
  // （交易已广播，报"失败"会导致用户重复发币——这是已踩过的坑）
  let receipt = null;
  for (let i = 0; i < 6 && !receipt; i++) {
    try {
      receipt = await tx.wait(1);
    } catch (err) {
      try {
        receipt = await provider.getTransactionReceipt(tx.hash);
      } catch { /* 继续重试 */ }
      if (!receipt) await new Promise((r) => setTimeout(r, 3000));
    }
  }

  if (!receipt) {
    // 交易已广播但回执暂不可得：返回 pending（不报错），前端提示去 BscScan 确认
    console.warn(`[relayer] 交易已广播但回执未取得: ${tx.hash}`);
    return {
      txHash: tx.hash,
      token: null,
      pending: true,
      explorer: EXPLORERS[cachedChainId] ?? "https://bscscan.com",
      message: "交易已广播，回执暂时查询不到（RPC 限流），请稍后用交易哈希在区块浏览器确认",
    };
  }

  let token = null;
  for (const log of receipt.logs) {
    // 中继合约事件（token 为 indexed，从 topics 解析）
    if (relayer) {
      try {
        const parsed = relayer.interface.parseLog(log);
        if (parsed && parsed.name === "LaunchSponsored") { token = parsed.args.token; break; }
      } catch { /* 非本合约日志 */ }
    }
    // Portal 事件（兜底）
    try {
      const parsed = portal.interface.parseLog(log);
      if (parsed && parsed.name === "TokenCreated") token = parsed.args.token;
    } catch { /* 非 Portal 日志 */ }
  }
  if (token) {
    launches.unshift({
      token, name: params.name, symbol: params.symbol, creator: params.creator,
      txHash: receipt.hash, ts: Date.now(), gasUsed: receipt.gasUsed?.toString(),
    });
    saveLaunches();
  }

  return {
    txHash: receipt.hash,
    token,
    flapUrl: token ? `https://flap.sh/bnb/${token}` : null,
    explorer: EXPLORERS[cachedChainId] ?? "https://bscscan.com",
    gasUsed: receipt.gasUsed?.toString(),
    costBnb: ethers.formatEther((receipt.gasUsed ?? 0n) * gasPrice + fee),
  };
}

// ---------------------------------------------------------------------------
// HTTP 层
// ---------------------------------------------------------------------------
const app = express();
app.use(cors({ origin: CORS_ORIGIN === "*" ? "*" : CORS_ORIGIN.split(",").map((s) => s.trim()) }));
app.use(express.json({ limit: "1mb" }));

// 健康检查：/health（本机直连）与 /api/health（经 nginx 反代）
// 区块浏览器基址（按链自动选择，前端据此生成链接）
const EXPLORERS = { 56: "https://bscscan.com", 97: "https://testnet.bscscan.com" };
let cachedChainId = null;

app.get(["/health", "/api/health"], async (_req, res) => {
  try {
    if (cachedChainId === null) {
      const net = await provider.getNetwork();
      cachedChainId = Number(net.chainId);
    }
  } catch { /* 保持 null */ }
  res.json({
    ok: true,
    portal: PORTAL_ADDRESS,
    chainId: cachedChainId,
    explorer: EXPLORERS[cachedChainId] ?? "https://bscscan.com",
  });
});

// 开发者互助基金：成功 DEV 自愿捐赠，供养后续创业者的发射费
const fundAddress = FUND_ADDRESS || wallet.address;
app.get("/api/fund", (_req, res) => {
  res.json({ ok: true, address: fundAddress, note: "开发者互助基金" });
});

// ---------------------------------------------------------------------------
// 荣誉墙：捐赠者登记（项目名称 + Logo），链上核验后公开上榜
// ---------------------------------------------------------------------------
const DONATIONS_FILE = path.join(__dirname, "donations.json");
const LAUNCHES_FILE = path.join(__dirname, "launches.json");
let launches = [];
try {
  launches = JSON.parse(fs.readFileSync(LAUNCHES_FILE, "utf8"));
} catch {
  launches = [];
}
function saveLaunches() {
  try { fs.writeFileSync(LAUNCHES_FILE, JSON.stringify(launches.slice(0, 200), null, 2)); } catch {}
}
let donations = [];
try {
  donations = JSON.parse(fs.readFileSync(DONATIONS_FILE, "utf8"));
} catch {
  donations = [];
}
function saveDonations() {
  try { fs.writeFileSync(DONATIONS_FILE, JSON.stringify(donations, null, 2)); } catch {}
}

app.get("/api/donations", (_req, res) => {
  res.json({ ok: true, donations: donations.slice(0, 100) });
});

app.post("/api/donations", async (req, res) => {
  try {
    const ip = getClientIp(req);
    if (!checkIpRate(ip)) return res.status(429).json({ ok: false, error: "RATE_LIMIT_IP" });

    const { name, logo, txHash, donor } = req.body || {};
    if (typeof name !== "string" || name.length < 1 || name.length > 32) {
      return res.status(400).json({ ok: false, error: "INVALID_NAME" });
    }
    if (typeof logo !== "string" || !logo.startsWith("data:image/") || logo.length > 200_000) {
      return res.status(400).json({ ok: false, error: "INVALID_LOGO" });
    }
    if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return res.status(400).json({ ok: false, error: "INVALID_TX" });
    }
    if (typeof donor !== "string" || !ethers.isAddress(donor)) {
      return res.status(400).json({ ok: false, error: "INVALID_DONOR" });
    }

    // 链上核验：真实打到基金地址的交易才允许上榜
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) return res.status(400).json({ ok: false, error: "TX_NOT_FOUND" });
    if (!receipt.to || receipt.to.toLowerCase() !== fundAddress.toLowerCase()) {
      return res.status(400).json({ ok: false, error: "TX_NOT_TO_FUND" });
    }
    const tx = await provider.getTransaction(txHash);
    if (!tx || tx.from.toLowerCase() !== donor.toLowerCase()) {
      return res.status(400).json({ ok: false, error: "DONOR_MISMATCH" });
    }
    if ((tx.value ?? 0n) <= 0n) return res.status(400).json({ ok: false, error: "ZERO_VALUE" });
    if (donations.some((d) => d.txHash === txHash)) {
      return res.status(400).json({ ok: false, error: "DUPLICATE" });
    }

    const entry = { name, logo, txHash, donor, value: tx.value.toString(), ts: Date.now() };
    donations.unshift(entry);
    saveDonations();
    res.json({ ok: true, entry });
  } catch (err) {
    console.error("[relayer] /api/donations failed:", err.shortMessage || err.message);
    res.status(500).json({ ok: false, error: "DONATION_ERROR" });
  }
});

// ---------------------------------------------------------------------------
// 模式 B · 自己创建（创建者=用户本人）
//   /api/prepare —— 后端磨盐 + 上传 LOGO，返回可直接调 Portal 的参数
//   /api/refund  —— 校验用户自己发的发币交易，经中继合约把 Gas 全额返还
// ---------------------------------------------------------------------------
app.post("/api/prepare", async (req, res) => {
  try {
    const ip = getClientIp(req);
    if (!(await verifyTurnstile(req.body?.turnstileToken, ip))) {
      return res.status(403).json({ ok: false, error: "TURNSTILE_FAILED" });
    }
    if (!checkIpRate(ip)) return res.status(429).json({ ok: false, error: "RATE_LIMIT_IP" });

    const params = validatePayload(req.body);
    const salt = grindSalt(params.impl, params.suffix);
    const meta = await uploadMetadata(params.meta, params.logo, params.creator);
    if (meta.length > MAX_META_LENGTH) throw new Error("META_TOO_LONG");

    const quoteAmt = BigInt(req.body?.quoteAmt ?? "0"); // 用户可选：创建即买入

    // 直接编码 calldata，前端无需 ABI 编码即可发送
    const calldata = portal.interface.encodeFunctionData("newTokenV6", [{
      name: params.name, symbol: params.symbol, meta,
      dexThresh: 1, salt, migratorType: params.tokenVersion === 6 ? 1 : 0,
      quoteToken: ZERO_ADDR, quoteAmt: quoteAmt.toString(),
      beneficiary: params.creator, permitData: "0x",
      extensionID: "0x" + "0".repeat(64), extensionData: "0x",
      dexId: 0, lpFeeProfile: 0,
      buyTaxRate: params.buyTaxRate, sellTaxRate: params.sellTaxRate,
      taxDuration: 31536000, antiFarmerDuration: params.antiFarmerDuration,
      mktBps: params.mktBps, deflationBps: params.deflationBps,
      dividendBps: params.dividendBps, lpBps: params.lpBps,
      minimumShareBalance: 0, dividendToken: ZERO_ADDR,
      commissionReceiver: params.commissionReceiver, tokenVersion: params.tokenVersion,
    }]);

    res.json({
      ok: true,
      portal: PORTAL_ADDRESS,
      // 前端直接发送这笔交易即可（to + data + value）
      to: PORTAL_ADDRESS,
      data: calldata,
      value: quoteAmt.toString(),
      name: params.name,
      symbol: params.symbol,
      params: {
        name: params.name, symbol: params.symbol, meta,
        dexThresh: 1, salt, migratorType: params.tokenVersion === 6 ? 1 : 0,
        quoteToken: ZERO_ADDR, quoteAmt: quoteAmt.toString(),
        beneficiary: params.creator, permitData: "0x",
        extensionID: "0x" + "0".repeat(64), extensionData: "0x",
        dexId: 0, lpFeeProfile: 0,
        buyTaxRate: params.buyTaxRate, sellTaxRate: params.sellTaxRate,
        taxDuration: 31536000, antiFarmerDuration: params.antiFarmerDuration,
        mktBps: params.mktBps, deflationBps: params.deflationBps,
        dividendBps: params.dividendBps, lpBps: params.lpBps,
        minimumShareBalance: 0, dividendToken: ZERO_ADDR,
        commissionReceiver: params.commissionReceiver, tokenVersion: params.tokenVersion,
      },
      // 这笔交易预计要花的 gas 上限（用户自付，之后全额返还）
      refundPolicy: { maxGasPriceGwei: MAX_GAS_PRICE_GWEI, maxRefundBnb: MAX_REFUND_BNB },
    });
  } catch (err) {
    const reason = err.shortMessage || err.message || "PREPARE_ERROR";
    console.error("[relayer] /api/prepare failed:", reason);
    res.status(400).json({ ok: false, error: reason });
  }
});

app.post("/api/refund", async (req, res) => {
  try {
    const ip = getClientIp(req);
    // Turnstile 可选：refund 已有「交易合法性 + creator 归属 + 防重复」三重校验；
    // Turnstile token 一次性，prepare 阶段已消耗，故此处仅在提供时校验
    if (req.body?.turnstileToken) {
      if (!(await verifyTurnstile(req.body.turnstileToken, ip))) {
        return res.status(403).json({ ok: false, error: "TURNSTILE_FAILED" });
      }
    }

    const { txHash, userAddress } = req.body || {};
    if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return res.status(400).json({ ok: false, error: "INVALID_TX" });
    }
    if (typeof userAddress !== "string" || !ethers.isAddress(userAddress)) {
      return res.status(400).json({ ok: false, error: "INVALID_ADDRESS" });
    }
    if (!relayer) return res.status(400).json({ ok: false, error: "REFUND_NOT_CONFIGURED" });

    // 取回执并校验这是一笔「用户自己发起、直接调用 Portal 的成功发币交易」
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) return res.status(400).json({ ok: false, error: "TX_NOT_FOUND" });
    if (receipt.status !== 1) return res.status(400).json({ ok: false, error: "TX_FAILED" });

    const tx = await provider.getTransaction(txHash);
    if (!tx) return res.status(400).json({ ok: false, error: "TX_NOT_FOUND" });
    if (tx.from.toLowerCase() !== userAddress.toLowerCase()) {
      return res.status(400).json({ ok: false, error: "SENDER_MISMATCH" });
    }
    if (!tx.to || tx.to.toLowerCase() !== PORTAL_ADDRESS.toLowerCase()) {
      return res.status(400).json({ ok: false, error: "NOT_PORTAL_CALL" });
    }

    // 必须确实创建了代币，且 creator 就是该用户
    let token = null, creator = null;
    for (const log of receipt.logs) {
      try {
        const parsed = portal.interface.parseLog(log);
        if (parsed && parsed.name === "TokenCreated") {
          token = parsed.args.token;
          creator = parsed.args.creator;
        }
      } catch { /* 忽略其他日志 */ }
    }
    if (!token) return res.status(400).json({ ok: false, error: "NOT_A_LAUNCH" });
    if (creator.toLowerCase() !== userAddress.toLowerCase()) {
      return res.status(400).json({ ok: false, error: "CREATOR_MISMATCH" });
    }

    // 计算用户实际支付的 gas
    const gasUsed = receipt.gasUsed;
    const gasPriceUsed = receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n;
    const gasCost = gasUsed * gasPriceUsed;
    const maxRefund = ethers.parseEther(MAX_REFUND_BNB);
    const refundAmount = gasCost > maxRefund ? maxRefund : gasCost;

    if (await relayer.refunded(txHash)) {
      return res.status(400).json({ ok: false, error: "ALREADY_REFUNDED" });
    }

    // 经中继合约返还（链上留痕 GasRefunded 事件）
    const feeData = await provider.getFeeData();
    const rtx = await relayer.refundGas(userAddress, txHash, {
      value: refundAmount,
      gasLimit: 200000,
      gasPrice: feeData.gasPrice,
    });
    const rrc = await rtx.wait();

    // 记录到看板
    launches.unshift({ token, name: req.body?.name ?? "", symbol: req.body?.symbol ?? "", creator: userAddress, txHash, ts: Date.now(), mode: "self" });
    saveLaunches();

    res.json({
      ok: true,
      token,
      refundTxHash: rtx.hash,
      refundedBnb: ethers.formatEther(refundAmount),
      gasCostBnb: ethers.formatEther(gasCost),
      explorer: EXPLORERS[cachedChainId] ?? "https://bscscan.com",
    });
  } catch (err) {
    const reason = err.shortMessage || err.message || "REFUND_ERROR";
    console.error("[relayer] /api/refund failed:", reason);
    res.status(500).json({ ok: false, error: reason });
  }
});

app.post("/api/launch", async (req, res) => {
  try {
    const ip = getClientIp(req);

    if (!(await verifyTurnstile(req.body?.turnstileToken, ip))) {
      return res.status(403).json({ ok: false, error: "TURNSTILE_FAILED" });
    }

    let params;
    try {
      params = validatePayload(req.body);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }

    if (!checkIpRate(ip)) {
      return res.status(429).json({ ok: false, error: "RATE_LIMIT_IP", retryAfterSec: 600 });
    }
    if (!checkWalletRate(params.creator)) {
      return res.status(429).json({ ok: false, error: "RATE_LIMIT_WALLET" });
    }

    const result = await submitLaunch(params);
    recordLaunch(ip, params.creator); // 仅成功发币才消耗额度
    res.json({ ok: true, ...result });
  } catch (err) {
    const reason = err.shortMessage || err.message || "RELAY_ERROR";
    console.error("[relayer] /api/launch failed:", reason);
    res.status(500).json({ ok: false, error: reason });
  }
});

// 最近发射：读中继器本地记录（发币成功时写入），不依赖链上 getLogs
app.get("/api/launches", (_req, res) => {
  res.json({ ok: true, launches: launches.slice(0, 50) });
});

// 股票底池：接入 FLAP 股票代币索引后填充（当前返回空，前端显示空状态）
const STOCK_POOLS = [];

app.get("/api/stocks", (_req, res) => {
  res.json({ ok: true, pools: STOCK_POOLS });
});

(async () => {
  app.listen(PORT, () => {
    console.log(`[relayer] FLAP 代付网关 listening on :${PORT} (portal ${PORTAL_ADDRESS}, wallet ${wallet.address}, fund ${fundAddress})`);
  });
})().catch((err) => {
  console.error("[relayer] boot failed:", err);
  process.exit(1);
});
