// 通过 Etherscan V2 API 提交 VortexRelayer 源码验证（chainid=56 = BSC）
const fs = require("fs");
const path = require("path");

const APIKEY = process.env.BSCSCAN_API_KEY || ""; // 从环境变量读，勿硬编码
const CONTRACT = "0x50036bB39667AbA7E42Cb43969A9c664A61A5DA6";
// 由 ethers 精确生成（ABI 编码，去 0x 前缀，长度 192）
const CTOR = "000000000000000000000000e2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0" +
             "0000000000000000000000004ed1d87e269f7f5a4490d66372514206b9d34a0b" +
             "000000000000000000000000000000000000000000000000002386f26fc10000";
if (CTOR.length !== 192) { console.error("构造参数长度错误:", CTOR.length); process.exit(1); }

(async () => {
  const source = fs.readFileSync(path.join(__dirname, "VortexRelayer.sol"), "utf8");
  const body = new URLSearchParams({
    module: "contract",
    action: "verifysourcecode",
    apikey: APIKEY,
    contractaddress: CONTRACT,
    sourceCode: source,
    codeformat: "solidity-single-file",
    contractname: "VortexRelayer",
    compilerversion: "v0.8.24+commit.e11b9ed9",
    optimizationUsed: "1",
    runs: "200",
    constructorArguements: CTOR,
    licenseType: "3", // MIT
    evmversion: "shanghai", // 与部署时 solc 0.8.24 默认值一致
  });

  console.log("提交验证 …");
  const res = await fetch("https://api.etherscan.io/v2/api?chainid=56", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  console.log("响应:", JSON.stringify(json).slice(0, 400));

  if (json.status === "1" && json.result) {
    const guid = json.result;
    console.log("\n✓ 已提交，GUID =", guid);
    console.log("等待 15 秒后查询状态 …");
    await new Promise((r) => setTimeout(r, 15000));
    const chk = await fetch(
      `https://api.etherscan.io/v2/api?chainid=56&module=contract&action=checkverifystatus&guid=${guid}&apikey=${APIKEY}`
    );
    const cj = await chk.json();
    console.log("状态:", JSON.stringify(cj).slice(0, 300));
  }
})().catch((e) => console.error("失败:", e.message));
