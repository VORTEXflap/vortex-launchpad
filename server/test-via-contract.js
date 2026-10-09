// 验证：经 Vortex 中继合约发币（真实主网）
require("dotenv").config();
const { ethers } = require("ethers");
const R = process.env.RELAYER_CONTRACT;
const PORTAL = process.env.PORTAL_ADDRESS;
const TAX_IMPL = process.env.TAX_IMPL;
const ABI = [
  "function sponsorLaunch((string name,string symbol,string meta,uint8 dexThresh,bytes32 salt,uint8 migratorType,address quoteToken,uint256 quoteAmt,address beneficiary,bytes permitData,bytes32 extensionID,bytes extensionData,uint8 dexId,uint8 lpFeeProfile,uint16 buyTaxRate,uint16 sellTaxRate,uint64 taxDuration,uint64 antiFarmerDuration,uint16 mktBps,uint16 deflationBps,uint16 dividendBps,uint16 lpBps,uint256 minimumShareBalance,address dividendToken,address commissionReceiver,uint8 tokenVersion) params) payable returns (address token)",
  "event LaunchSponsored(address indexed token, address indexed creator, address indexed operator, uint256 value, uint256 ts)",
  "function operators(address) view returns (bool)",
  "function maxValuePerLaunch() view returns (uint256)",
  "function paused() view returns (bool)",
];
const PP = "0x3d602d80600a3d3981f3363d3d373d3d3d363d73", PS = "5af43d82803e903d91602b57fd5bf3";
function computeAddr(salt) {
  return ethers.getCreate2Address(PORTAL, salt, ethers.keccak256(PP + TAX_IMPL.slice(2).toLowerCase() + PS));
}
function grind() {
  for (let i = 0; i < 500000; i++) {
    const s = ethers.hexlify(ethers.randomBytes(32));
    if (computeAddr(s).slice(-4) === "7777") return s;
  }
  throw new Error("grind fail");
}
(async () => {
  const provider = new ethers.JsonRpcProvider((process.env.RPC_URLS || process.env.RPC_URL).split(",")[0]);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const c = new ethers.Contract(R, ABI, wallet);

  console.log("=== 经中继合约发币验证 ===");
  console.log("中继合约 :", R);
  console.log("热钱包   :", wallet.address);
  console.log("已授权   :", await c.operators(wallet.address) ? "✓ 是 operator" : "✗ 未授权");
  console.log("maxValue :", ethers.formatEther(await c.maxValuePerLaunch()), "BNB");
  console.log("暂停状态 :", await c.paused() ? "已暂停" : "运行中");
  console.log("余额     :", ethers.formatEther(await provider.getBalance(wallet.address)), "BNB");

  const salt = grind();
  const args = {
    name: "Vortex Contract Test", symbol: "VCT", meta: "",
    dexThresh: 1, salt, migratorType: 1,
    quoteToken: ethers.ZeroAddress, quoteAmt: 0, beneficiary: wallet.address,
    permitData: "0x", extensionID: ethers.ZeroHash, extensionData: "0x",
    dexId: 0, lpFeeProfile: 0, buyTaxRate: 300, sellTaxRate: 300,
    taxDuration: 31536000, antiFarmerDuration: 0,
    mktBps: 10000, deflationBps: 0, dividendBps: 0, lpBps: 0,
    minimumShareBalance: 0, dividendToken: ethers.ZeroAddress,
    commissionReceiver: ethers.ZeroAddress, tokenVersion: 6,
  };
  console.log("\n发送交易（经合约）…");
  const fd = await provider.getFeeData();
  const est = await c.sponsorLaunch.estimateGas(args, { value: 0 });
  console.log("预估 gas:", est.toString());
  const tx = await c.sponsorLaunch(args, { value: 0, gasLimit: est * 120n / 100n, gasPrice: fd.gasPrice });
  console.log("tx:", tx.hash);
  const r = await tx.wait();
  console.log("状态:", r.status === 1 ? "✓ 成功" : "✗ 失败", "| gasUsed", r.gasUsed.toString());

  let token = null;
  for (const log of r.logs) {
    try { const p = c.interface.parseLog(log); if (p?.name === "LaunchSponsored") token = p.args.token; } catch {}
  }
  console.log("");
  if (token) {
    console.log("✓ 通过中继合约发出的代币:", token);
    console.log("  后缀:", token.slice(-4), "| 预测一致:", token.toLowerCase() === computeAddr(salt).toLowerCase() ? "是" : "否");
    console.log("  BscScan: https://bscscan.com/address/" + token);
    console.log("  合约交易: https://bscscan.com/tx/" + tx.hash);
  } else { console.log("✗ 未解析到 LaunchSponsored 事件"); }
})().catch((e) => console.error("失败:", e.shortMessage || e.message));
