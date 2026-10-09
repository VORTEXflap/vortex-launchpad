/**
 * Vortex 真实发币端到端测试（会真实上链，花掉测试网 BNB）
 *
 * 用途：在接入前端 Turnstile 之前，先用真实私钥验证「磨盐 → 代付 → Portal 上链」
 *      整条链路是否真的能发出代币。参数是 eth_call 模拟测试验证过的那组。
 *
 * 用法：node test-launch.js            （默认发一枚测试代币）
 *      node test-launch.js "我的币" MYB
 *
 * 前置：.env 中 RPC_URL / PRIVATE_KEY / PORTAL_ADDRESS / TAX_IMPL 已填，
 *      且热钱包在对应网络有少量 BNB（测试网去 faucet 领）。
 */
"use strict";

require("dotenv").config();
const { ethers } = require("ethers");

const {
  RPC_URL, PRIVATE_KEY,
  PORTAL_ADDRESS = "0x5bEacaF7ABCbB3aB280e80D007FD31fcE26510e9",
  TAX_IMPL = "0xE6Ff967a887084c16D0fD71548CF709542cc1557",
  CREATION_FEE = "1000000000000000",
} = process.env;

const PORTAL_ABI = [
  "function newTokenV6((string name,string symbol,string meta,uint8 dexThresh,bytes32 salt,uint8 migratorType,address quoteToken,uint256 quoteAmt,address beneficiary,bytes permitData,bytes32 extensionID,bytes extensionData,uint8 dexId,uint8 lpFeeProfile,uint16 buyTaxRate,uint16 sellTaxRate,uint64 taxDuration,uint64 antiFarmerDuration,uint16 mktBps,uint16 deflationBps,uint16 dividendBps,uint16 lpBps,uint256 minimumShareBalance,address dividendToken,address commissionReceiver,uint8 tokenVersion) params) external payable returns (address token)",
  // 实测无 indexed：indexed 不影响签名哈希，但会让 topics 数量不符导致解析失败
  "event TokenCreated(uint256 ts, address creator, uint256 nonce, address token, string name, string symbol, string meta)",
];

const PROXY_PREFIX = "0x3d602d80600a3d3981f3363d3d373d3d3d363d73";
const PROXY_SUFFIX = "5af43d82803e903d91602b57fd5bf3";

function computeAddr(salt) {
  const init = PROXY_PREFIX + TAX_IMPL.slice(2).toLowerCase() + PROXY_SUFFIX;
  return ethers.getCreate2Address(PORTAL_ADDRESS, salt, ethers.keccak256(init));
}

/** 磨盐：税收代币地址必须以 7777 结尾 */
function grindSalt(suffix = "7777") {
  for (let i = 0; i < 500000; i++) {
    const salt = ethers.hexlify(ethers.randomBytes(32));
    if (computeAddr(salt).slice(-suffix.length) === suffix) return salt;
  }
  throw new Error("磨盐失败：尝试 50 万次未命中后缀");
}

async function main() {
  const name = process.argv[2] || "Vortex Test Token";
  const symbol = process.argv[3] || "VTEST";

  if (!PRIVATE_KEY || PRIVATE_KEY.includes("0000000000000000000000000000000000000000000000000000000000000000")) {
    console.error("✗ 请先在 .env 填写真实 PRIVATE_KEY"); process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const net = await provider.getNetwork();
  const chainName = net.chainId === 56n ? "BSC 主网" : net.chainId === 97n ? "BSC 测试网" : `链 ${net.chainId}`;
  const portal = new ethers.Contract(PORTAL_ADDRESS, PORTAL_ABI, wallet);

  console.log("=== Vortex 真实发币测试 ===");
  console.log("网络      :", chainName);
  console.log("热钱包    :", wallet.address);
  const bal = await provider.getBalance(wallet.address);
  console.log("BNB 余额  :", ethers.formatEther(bal));
  console.log("Portal    :", PORTAL_ADDRESS);

  const fee = BigInt(CREATION_FEE);
  if (bal < fee) {
    console.error(`✗ 余额不足：需要 ${ethers.formatEther(fee)} BNB 付创建费`);
    process.exit(1);
  }

  console.log("\n[1/4] 磨盐（地址后缀 7777）…");
  const salt = grindSalt("7777");
  console.log("      salt      :", salt);
  console.log("      预测地址  :", computeAddr(salt));

  const params = {
    name, symbol, meta: "",
    dexThresh: 1,                 // FOUR_FIFTHS（测试网实测唯一支持值）
    salt,
    migratorType: 1,              // V2_MIGRATOR（税收代币必须）
    quoteToken: ethers.ZeroAddress,
    quoteAmt: 0,                  // 代付网关不代买
    beneficiary: wallet.address,  // 代币归属：创建者（此处即热钱包，正式版为用户地址）
    permitData: "0x",
    extensionID: ethers.ZeroHash,
    extensionData: "0x",
    dexId: 0,
    lpFeeProfile: 0,
    buyTaxRate: 300, sellTaxRate: 300,   // 3%/3%
    taxDuration: 31536000, antiFarmerDuration: 0,  // taxDuration 必须 > 0（实测 0 会 revert）
    mktBps: 10000, deflationBps: 0, dividendBps: 0, lpBps: 0,
    minimumShareBalance: 0,
    dividendToken: ethers.ZeroAddress,
    commissionReceiver: ethers.ZeroAddress,
    tokenVersion: 6,              // TOKEN_TAXED_V3
  };

  console.log("\n[2/4] 估算 Gas …");
  try {
    const est = await portal.newTokenV6.estimateGas(params, { value: fee });
    console.log("      预估 Gas  :", est.toString());
  } catch (e) {
    console.error("✗ estimateGas 失败:", e.shortMessage || e.message);
    console.error("  → 说明参数或余额有问题，未发送交易（未花钱）");
    process.exit(1);
  }

  console.log("\n[3/4] 发送交易（真实上链，请稍候）…");
  const tx = await portal.newTokenV6(params, { value: fee });
  console.log("      txHash    :", tx.hash);
  const receipt = await tx.wait();
  console.log("      区块      :", receipt.blockNumber, "| 状态:", receipt.status === 1 ? "成功" : "失败");

  console.log("\n[4/4] 解析 TokenCreated 事件 …");
  let token = null;
  for (const log of receipt.logs) {
    try {
      const parsed = portal.interface.parseLog(log);
      if (parsed && parsed.name === "TokenCreated") token = parsed.args.token;
    } catch { /* 非 Portal 日志 */ }
  }

  if (token) {
    console.log("      ✓ 代币地址 :", token);
    console.log("      ✓ 后缀匹配 :", token.slice(-4) === "7777" ? "7777 ✓" : token.slice(-4) + " ✗");
    console.log("      ✓ 预测一致 :", token.toLowerCase() === computeAddr(salt).toLowerCase() ? "是" : "否");
    const base = net.chainId === 97n ? "https://testnet.bscscan.com" : "https://bscscan.com";
    console.log("\n  浏览器 :", `${base}/address/${token}`);
    console.log("  FLAP   :", `https://flap.sh/bnb/${token}`);
  } else {
    console.log("      × 未在日志中找到 TokenCreated（交易可能回滚）");
  }
}

main().catch((e) => {
  console.error("\n✗ 失败:", e.shortMessage || e.message);
  process.exit(1);
});
