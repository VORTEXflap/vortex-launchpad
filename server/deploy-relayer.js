// 编译并部署 VortexRelayer 中继合约到 BSC 主网
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const solc = require("solc");
const { ethers } = require("ethers");

const SRC = path.join(__dirname, "VortexRelayer.sol");
const PORTAL = process.env.PORTAL_ADDRESS || "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0";
const MAX_VALUE = ethers.parseEther("0.01"); // 单次发射 value 上限 0.01 BNB

(async () => {
  // 1) 编译
  console.log("[1/3] 编译合约 …");
  const source = fs.readFileSync(SRC, "utf8");
  const input = {
    language: "Solidity",
    sources: { "VortexRelayer.sol": { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors || []).filter((e) => e.severity === "error");
  if (errors.length) {
    console.error("编译失败:"); errors.forEach((e) => console.error("  " + e.formattedMessage));
    process.exit(1);
  }
  (out.errors || []).forEach((e) => console.log("  [warn] " + e.formattedMessage.split("\n")[0]));
  const c = out.contracts["VortexRelayer.sol"]["VortexRelayer"];
  const bytecode = "0x" + c.evm.bytecode.object;
  console.log("  ✓ 编译成功 | 字节码", ((bytecode.length - 2) / 2), "字节");

  // 2) 连接
  const provider = new ethers.JsonRpcProvider((process.env.RPC_URLS || process.env.RPC_URL).split(",")[0]);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const bal = await provider.getBalance(wallet.address);
  console.log("\n[2/3] 部署者:", wallet.address, "| 余额", ethers.formatEther(bal), "BNB");
  console.log("      Portal:", PORTAL);
  console.log("      Operator(热钱包):", wallet.address, "| maxValue:", ethers.formatEther(MAX_VALUE), "BNB");

  // 3) 部署
  console.log("\n[3/3] 部署中 …");
  const factory = new ethers.ContractFactory(c.abi, bytecode, wallet);
  const fee = await provider.getFeeData();
  const contract = await factory.deploy(PORTAL, wallet.address, MAX_VALUE, {
    gasPrice: fee.gasPrice,
  });
  const tx = contract.deploymentTransaction();
  console.log("      tx:", tx.hash);
  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  const receipt = await provider.getTransactionReceipt(tx.hash);

  console.log("");
  console.log("=== 部署完成 ===");
  console.log("中继合约地址:", addr);
  console.log("区块        :", receipt.blockNumber, "| gasUsed", receipt.gasUsed.toString());
  console.log("BscScan     : https://bscscan.com/address/" + addr);
  console.log("剩余余额    :", ethers.formatEther(await provider.getBalance(wallet.address)), "BNB");
  console.log("");
  console.log("请把该地址写入服务器 .env 的 RELAYER_CONTRACT=");
})().catch((e) => console.error("失败:", e.shortMessage || e.message));
