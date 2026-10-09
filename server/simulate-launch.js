// FLAP Portal 发射模拟测试（eth_call，不花真钱）
// 验证：ABI 类型、磨盐后缀规则、创建费金额 —— 用 revert 数据解码 InsufficientCreationFee
const { ethers } = require("ethers");

const PORTAL = "0x5bEacaF7ABCbB3aB280e80D007FD31fcE26510e9"; // 测试网
const TAX_IMPL = "0xE6Ff967a887084c16D0fD71548CF709542cc1557";

const PORTAL_ABI = [
  "function newTokenV6((string name,string symbol,string meta,uint8 dexThresh,bytes32 salt,uint8 migratorType,address quoteToken,uint256 quoteAmt,address beneficiary,bytes permitData,bytes32 extensionID,bytes extensionData,uint8 dexId,uint8 lpFeeProfile,uint16 buyTaxRate,uint16 sellTaxRate,uint64 taxDuration,uint64 antiFarmerDuration,uint16 mktBps,uint16 deflationBps,uint16 dividendBps,uint16 lpBps,uint256 minimumShareBalance,address dividendToken,address commissionReceiver,uint8 tokenVersion) params) external payable returns (address token)",
  "error InsufficientCreationFee(uint256 required, uint256 provided)",
  "error InsufficientFee(uint256 required, uint256 provided)",
];

const PROXY_PREFIX = "0x3d602d80600a3d3981f3363d3d373d3d3d363d73";
const PROXY_SUFFIX = "5af43d82803e903d91602b57fd5bf3";

function computeTokenAddress(salt) {
  const initCode = PROXY_PREFIX + TAX_IMPL.slice(2).toLowerCase() + PROXY_SUFFIX;
  return ethers.getCreate2Address(PORTAL, salt, ethers.keccak256(initCode));
}

function grindSalt() {
  for (let i = 0; i < 500000; i++) {
    const salt = ethers.hexlify(ethers.randomBytes(32));
    if (computeTokenAddress(salt).slice(-4) === "7777") return salt;
  }
  throw new Error("grind failed");
}

async function main() {
  const provider = new ethers.JsonRpcProvider("https://bsc-testnet-rpc.publicnode.com");
  const iface = new ethers.Interface(PORTAL_ABI);
  const caller = ethers.Wallet.createRandom(); // 任意调用方

  const salt = grindSalt();
  const predicted = computeTokenAddress(salt);
  console.log("盐:", salt);
  console.log("磨盐后预测地址:", predicted, "后缀 7777:", predicted.slice(-4) === "7777");

  const params = {
    name: "Vortex Test", symbol: "VTX", meta: "ipfs://",
    dexThresh: 0, salt,
    migratorType: 1, // V2_MIGRATOR
    quoteToken: ethers.ZeroAddress, quoteAmt: ethers.parseEther("0.01"),
    beneficiary: caller.address, permitData: "0x",
    extensionID: ethers.ZeroHash, extensionData: "0x",
    dexId: 0, lpFeeProfile: 0,
    buyTaxRate: 300, sellTaxRate: 300,
    taxDuration: 0, antiFarmerDuration: 0,
    mktBps: 10000, deflationBps: 0, dividendBps: 0, lpBps: 0,
    minimumShareBalance: 0, dividendToken: ethers.ZeroAddress,
    commissionReceiver: caller.address, tokenVersion: 6, // TOKEN_TAXED_V3
  };

  // 尝试 1: value = 0.011 BNB（假设创建费 0.001 + quoteAmt 0.01）
  for (const [label, value] of [["0.011 BNB", ethers.parseEther("0.011")], ["0.01 BNB", ethers.parseEther("0.01")]]) {
    const calldata = iface.encodeFunctionData("newTokenV6", [params]);
    try {
      const res = await provider.call({ from: caller.address, to: PORTAL, data: calldata, value });
      console.log(`\n[${label}] eth_call 成功 → 返回:`, res, res !== "0x" ? `→ 发射地址 ${ethers.AbiCoder.defaultAbiCoder().decode(["address"], res)[0]}` : "");
    } catch (e) {
      const reason = e.shortMessage || e.message || "";
      console.log(`\n[${label}] revert:`, reason.slice(0, 100));
      // 解码自定义错误
      const data = e.data ?? e.error?.data;
      if (data) {
        try {
          const parsed = iface.parseError(data);
          if (parsed) {
            console.log("   解码错误:", parsed.name, parsed.args.map((a) => (typeof a === "bigint" ? a.toString() + " (" + ethers.formatEther(a) + " BNB)" : a.toString())).join(", "));
          }
        } catch { console.log("   原始 revert data:", data.slice(0, 80)); }
      }
    }
  }
}

main().catch((e) => { console.error("ERR", e.shortMessage || e.message); process.exit(1); });
