// 测试 FLAP 元数据上传 API（GraphQL multipart）
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

(async () => {
  const buf = Buffer.from(PNG_1x1, "base64");
  const form = new FormData();
  form.append("operations", JSON.stringify({
    query: "mutation Create($file: Upload!, $meta: MetadataInput!) { create(file: $file, meta: $meta) }",
    variables: {
      file: null,
      meta: {
        description: "Vortex 测试代币",
        creator: "0x0000000000000000000000000000000000000000",
        website: null, twitter: null, telegram: null,
      },
    },
  }));
  form.append("map", JSON.stringify({ "0": ["variables.file"] }));
  form.append("0", new Blob([buf], { type: "image/png" }), "logo.png");

  console.log("上传中 …");
  const res = await fetch("https://funcs.flap.sh/api/upload", { method: "POST", body: form });
  const text = await res.text();
  console.log("HTTP", res.status);
  console.log("响应:", text.slice(0, 400));
  try {
    const j = JSON.parse(text);
    if (j?.data?.create) {
      console.log("");
      console.log("✓ 上传成功，CID =", j.data.create);
      console.log("网关验证: https://flap.mypinata.cloud/ipfs/" + j.data.create);
    }
  } catch { /* 非 JSON */ }
})().catch((e) => console.error("失败:", e.message));
