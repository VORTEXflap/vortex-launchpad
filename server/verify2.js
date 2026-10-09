require("dotenv").config();
const fs = require("fs"), path = require("path");
const APIKEY = process.env.BSCSCAN_API_KEY || ""; // 从环境变量读，勿硬编码
const CONTRACT = "0x217264D477fC576B2768E2EABE7e8408CB17F39F";
const CTOR = "000000000000000000000000e2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0" +
             "0000000000000000000000004ed1d87e269f7f5a4490d66372514206b9d34a0b" +
             "000000000000000000000000000000000000000000000000002386f26fc10000";
(async () => {
  if (CTOR.length !== 192) { console.error("构造参数长度错误", CTOR.length); process.exit(1); }
  const source = fs.readFileSync(path.join(__dirname, "VortexRelayer.sol"), "utf8");
  const body = new URLSearchParams({
    module: "contract", action: "verifysourcecode", apikey: APIKEY,
    contractaddress: CONTRACT, sourceCode: source,
    codeformat: "solidity-single-file", contractname: "VortexRelayer",
    compilerversion: "v0.8.24+commit.e11b9ed9", optimizationUsed: "1", runs: "200",
    constructorArguements: CTOR, licenseType: "3", evmversion: "shanghai",
  });
  const res = await fetch("https://api.etherscan.io/v2/api?chainid=56", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  const j = await res.json();
  console.log("提交:", JSON.stringify(j).slice(0, 200));
  if (j.status === "1") {
    await new Promise((r) => setTimeout(r, 20000));
    const c = await (await fetch(`https://api.etherscan.io/v2/api?chainid=56&module=contract&action=checkverifystatus&guid=${j.result}&apikey=${APIKEY}`)).json();
    console.log("状态:", JSON.stringify(c).slice(0, 200));
  }
})().catch((e) => console.error("失败:", e.message));
