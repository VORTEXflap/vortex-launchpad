/**
 * BSC 主网发币模拟验证（eth_call，不花钱）
 * 目的：确认主网 Portal 参数、dexThresh 支持范围、创建费，再决定是否真发
 */
const { ethers } = require("ethers");

const MAINNET_RPCS = [
  "https://bsc-rpc.publicnode.com",
  "https://bsc-dataseed1.binance.org",
  "https://binance.llamarpc.com",
];

// 主网地址（FLAP 官方文档）
const PORTAL = "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0";
const TAX_IMPL = "0x024f18294970B5c76c0691b87f138A0317156422";
const STD_IMPL_V3 = "0x88881b6f03090462a969eC7f48385744Eeb63333";

const PORTAL_ABI = [
  "function newTokenV6((string name,string symbol,string meta,uint8 dexThresh,bytes32 salt,uint8 migratorType,address quoteToken,uint256 quoteAmt,address beneficiary,bytes permitData,bytes32 extensionID,bytes extensionData,uint8 dexId,uint8 lpFeeProfile,uint16 buyTaxRate,uint16 sellTaxRate,uint64 taxDuration,uint64 antiFarmerDuration,uint16 mktBps,uint16 deflationBps,uint16 dividendBps,uint16 lpBps,uint256 minimumShareBalance,address dividendToken,address commissionReceiver,uint8 tokenVersion) params) external payable returns (address token)",
];

const PP = "0x3d602d80600a3d3981f3363d3d373d3d3d363d73";
const PS = "5af43d82803e903d91602b57fd5bf3";

function computeAddr(salt, impl) {
  const init = PP + impl.slice(2).toLowerCase() + PS;
  return ethers.getCreate2Address(PORTAL, salt, ethers.keccak256(init));
}
function grind(impl, suffix) {
  for (let i = 0; i < 500000; i++) {
    const s = ethers.hexlify(ethers.randomBytes(32));
    if (computeAddr(s, impl).slice(-4) === suffix) return s;
  }
  throw new Error("grind fail");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (const rpc of MAINNET_RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(rpc);
      await Promise.race([p.getNetwork(), new Promise((_, r) => setTimeout(() => r(new Error("t")), 9000))]);
      console.log("RPC:", rpc);
      return p;
    } catch { /* next */ }
  }
  throw new Error("无可用主网 RPC");
}

async function call(p, iface, params, value, caller) {
  const data = iface.encodeFunctionData("newTokenV6", [params]);
  for (const rpc of MAINNET_RPCS) {
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "eth_call",
            params: [
              { from: caller, to: PORTAL, data, value: "0x" + value.toString(16) },
              "latest",
              { [caller]: { balance: "0x" + ethers.parseEther("10").toString(16) } },
            ],
          }),
        });
        const j = JSON.parse(await res.text());
        if (j.result !== undefined || j.error !== undefined) return j;
      } catch { /* retry */ }
      await sleep(1500);
    }
  }
  return null;
}

(async () => {
  const provider = await connect();
  const iface = new ethers.Interface(PORTAL_ABI);

  console.log("\n=== 1) 主网合约存在性 ===");
  for (const [name, addr] of [["Portal", PORTAL], ["TaxV3 Impl", TAX_IMPL], ["StdV3 Impl", STD_IMPL_V3]]) {
    const code = await provider.getCode(addr);
    console.log(`${name.padEnd(12)} ${addr} → ${code !== "0x" ? "✓ 存在" : "✗ 无代码"}`);
  }

  // 主网 gasPrice
  const fd = await provider.getFeeData();
  console.log("\n主网 gasPrice:", ethers.formatUnits(fd.gasPrice ?? fd.maxFeePerGas, "gwei"), "gwei");

  const caller = ethers.Wallet.createRandom();
  const base = (salt) => ({
    name: "Vortex Mainnet Test", symbol: "VMT", meta: "",
    dexThresh: 1, salt, migratorType: 1,
    quoteToken: ethers.ZeroAddress, quoteAmt: 0, beneficiary: caller.address,
    permitData: "0x", extensionID: ethers.ZeroHash, extensionData: "0x",
    dexId: 0, lpFeeProfile: 0,
    buyTaxRate: 300, sellTaxRate: 300,
    taxDuration: 31536000, antiFarmerDuration: 0,
    mktBps: 10000, deflationBps: 0, dividendBps: 0, lpBps: 0,
    minimumShareBalance: 0, dividendToken: ethers.ZeroAddress,
    commissionReceiver: ethers.ZeroAddress, tokenVersion: 6,
  });

  console.log("\n=== 2) 主网 dexThresh 支持范围扫描（税收代币 V3）===");
  const salt0 = grind(TAX_IMPL, "7777");
  const results = [];
  for (let dt = 0; dt <= 5; dt++) {
    const params = { ...base(salt0), dexThresh: dt };
    const j = await call(provider, iface, params, ethers.parseEther("0.01"), caller.address);
    const ok = j && j.result && j.result !== "0x";
    results.push({ dt, ok, err: j?.error?.message || "" });
    console.log(`  dexThresh=${dt} → ${ok ? "✅ 成功" : "❌ " + (j?.error?.message || "无响应").slice(0, 50)}`);
    await sleep(1200);
  }

  const best = results.find((r) => r.ok);
  console.log("\n=== 3) 创建费探测（用可用 dexThresh 试不同 value）===");
  if (best) {
    for (const v of ["0", "0.0001", "0.001", "0.002", "0.005", "0.01"]) {
      const params = { ...base(salt0), dexThresh: best.dt };
      const j = await call(provider, iface, params, ethers.parseEther(v), caller.address);
      const ok = j && j.result && j.result !== "0x";
      console.log(`  value=${v} BNB → ${ok ? "✅ 成功（创建费 ≤ " + v + "）" : "❌ " + (j?.error?.message || "").slice(0, 60)}`);
      await sleep(1200);
    }
  }

  console.log("\n=== 结论 ===");
  console.log(best ? `主网可发币 dexThresh=${best.dt}` : "⚠ 主网模拟未通过，需进一步排查");
})().catch((e) => console.error("失败:", e.message));
