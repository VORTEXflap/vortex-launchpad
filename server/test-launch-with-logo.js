// 真实验证：带 LOGO 的发币全链路（IPFS 上传 → CID → Portal meta）
require("dotenv").config();
const { ethers } = require("ethers");

const PORTAL_ADDRESS = process.env.PORTAL_ADDRESS;
const TAX_IMPL = process.env.TAX_IMPL;
const METADATA_API = process.env.METADATA_API || "https://funcs.flap.sh/api/upload";
const PORTAL_ABI = [
  "function newTokenV6((string name,string symbol,string meta,uint8 dexThresh,bytes32 salt,uint8 migratorType,address quoteToken,uint256 quoteAmt,address beneficiary,bytes permitData,bytes32 extensionID,bytes extensionData,uint8 dexId,uint8 lpFeeProfile,uint16 buyTaxRate,uint16 sellTaxRate,uint64 taxDuration,uint64 antiFarmerDuration,uint16 mktBps,uint16 deflationBps,uint16 dividendBps,uint16 lpBps,uint256 minimumShareBalance,address dividendToken,address commissionReceiver,uint8 tokenVersion) params) external payable returns (address token)",
  "event TokenCreated(uint256 ts, address creator, uint256 nonce, address token, string name, string symbol, string meta)",
];
const PP = "0x3d602d80600a3d3981f3363d3d373d3d3d363d73";
const PS = "5af43d82803e903d91602b57fd5bf3";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function computeAddr(salt) {
  const init = PP + TAX_IMPL.slice(2).toLowerCase() + PS;
  return ethers.getCreate2Address(PORTAL_ADDRESS, salt, ethers.keccak256(init));
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
  const portal = new ethers.Contract(PORTAL_ADDRESS, PORTAL_ABI, wallet);

  console.log("=== 带 LOGO 的发币验证 ===");
  console.log("热钱包:", wallet.address, "| 余额", ethers.formatEther(await provider.getBalance(wallet.address)), "BNB");

  // 1) 上传 LOGO 到 FLAP IPFS
  console.log("\n[1/3] 上传 LOGO 到 FLAP IPFS …");
  const buf = Buffer.from(PNG, "base64");
  const form = new FormData();
  form.append("operations", JSON.stringify({
    query: "mutation Create($file: Upload!, $meta: MetadataInput!) { create(file: $file, meta: $meta) }",
    variables: { file: null, meta: { description: "Vortex 带图测试", creator: wallet.address, website: null, twitter: null, telegram: null } },
  }));
  form.append("map", JSON.stringify({ "0": ["variables.file"] }));
  form.append("0", new Blob([buf], { type: "image/png" }), "logo.png");
  const up = await fetch(METADATA_API, { method: "POST", body: form });
  const upJson = await up.json();
  const cid = upJson?.data?.create;
  if (!cid) { console.error("✗ 上传失败:", JSON.stringify(upJson).slice(0, 200)); process.exit(1); }
  console.log("      ✓ CID =", cid);

  // 2) 发币（meta = CID）
  console.log("\n[2/3] 发币（meta 传 CID）…");
  const salt = grind();
  const args = {
    name: "Vortex Logo Test", symbol: "VLT", meta: cid,
    dexThresh: 1, salt, migratorType: 1,
    quoteToken: ethers.ZeroAddress, quoteAmt: 0, beneficiary: wallet.address,
    permitData: "0x", extensionID: ethers.ZeroHash, extensionData: "0x",
    dexId: 0, lpFeeProfile: 0, buyTaxRate: 300, sellTaxRate: 300,
    taxDuration: 31536000, antiFarmerDuration: 0,
    mktBps: 10000, deflationBps: 0, dividendBps: 0, lpBps: 0,
    minimumShareBalance: 0, dividendToken: ethers.ZeroAddress,
    commissionReceiver: ethers.ZeroAddress, tokenVersion: 6,
  };
  const tx = await portal.newTokenV6(args, { value: 0, gasLimit: 12000000, gasPrice: (await provider.getFeeData()).gasPrice });
  console.log("      tx:", tx.hash);
  const r = await tx.wait();
  let token = null;
  for (const log of r.logs) {
    try { const p = portal.interface.parseLog(log); if (p?.name === "TokenCreated") token = p.args.token; } catch {}
  }
  console.log("      状态:", r.status === 1 ? "成功" : "失败", "| gasUsed", r.gasUsed.toString());

  // 3) 验证
  console.log("\n[3/3] 验证代币元数据 …");
  if (token) {
    console.log("      代币:", token);
    console.log("      BscScan: https://bscscan.com/address/" + token);
    console.log("      FLAP: https://flap.sh/bnb/" + token);
    console.log("      LOGO 网关: https://flap.mypinata.cloud/ipfs/" + cid);
  }
})().catch((e) => console.error("失败:", e.shortMessage || e.message));
