"use client";

import { useEffect, useRef, useState } from "react";
import { isAddress, type Address } from "viem";
import { useAppKit, useAppKitAccount } from "@reown/appkit/react";
import { Turnstile } from "@marsidev/react-turnstile";

/**
 * Vortex — FLAP 手续费代付网关
 *
 * 业务模型：用户在 Vortex 填表发币，Vortex 代付 FLAP 创建手续费（约 0.001 BNB），
 * 由中继器调用 FLAP Portal 的 newTokenV6() 发射——代币最终上线 FLAP：
 * https://flap.sh/bnb/{token}
 *
 * 设计语言参考 https://flap.sh/launch：
 *   背景 #070808 · 文字 #F9FAFB · 边框 #303236 · 主色 --vortex-accent（LOGO 金色 #E0A000）
 */
const ACCENT = "var(--vortex-accent, #E0A000)";

const RELAYER_URL = process.env.NEXT_PUBLIC_RELAYER_URL ?? "http://localhost:8080";
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";

type Phase = "idle" | "verify" | "submitting" | "done";

/** 发射模式：tax → FLAP TOKEN_TAXED_V3（税收代币），standard → 标准代币 */
type TokenType = "tax" | "standard";

const MODE_CARDS: { id: TokenType; title: string; desc: string }[] = [
  { id: "tax", title: "税收模式 · Tax Token V3", desc: "FLAP 税收代币：买/卖税率可配 0–10%，税收按比例分配给创作者/销毁/分红/流动性" },
  { id: "standard", title: "零税标准代币 Standard", desc: "FLAP 标准代币：0 手续费交易，联合曲线阶段后迁移 DEX" },
];

/** 支付代币（FLAP 式分类：精选/全部/股票代币/Pre-IPO）。代付网关当前仅 BNB 计价。 */
type QuoteCat = "featured" | "all" | "stocks" | "preipo";

const QUOTE_CATEGORIES: { id: QuoteCat; label: string }[] = [
  { id: "featured", label: "精选" },
  { id: "all", label: "全部" },
  { id: "stocks", label: "股票代币" },
  { id: "preipo", label: "Pre-IPO" },
];

// 股票池完整列表（与 FLAP 股票代币分类一致，90 个）：[symbol, 名称]
const STOCK_QUOTES: [string, string][] = [
  ["XAUT", "黄金 Tether Gold"], ["SPCXB", "SpaceX"], ["SKHYB", "SK海力士"], ["SPYB", "标普500 ETF"],
  ["QQQB", "纳斯达克100"], ["NVDAB", "英伟达"], ["AAPLB", "苹果"], ["TSLAB", "特斯拉"],
  ["wXIAOx", "小米（封装）"], ["WENB", "温蒂汉堡"], ["PDDB", "拼多多"], ["FWDIB", "Forward Industries"],
  ["SHAZB", "SharonAI"], ["ADBEB", "Adobe"], ["HPEB", "慧与科技"], ["ZMB", "Zoom"],
  ["wTCENTx", "腾讯（封装）"], ["wPOPMTx", "泡泡玛特（封装）"], ["AGPUB", "Axe Compute"], ["CYPHB", "Cypherpunk"],
  ["AMCB", "AMC院线"], ["aWDH", "水滴公司"], ["MSFTB", "微软"], ["GOOGLB", "谷歌"],
  ["HOODB", "Robinhood"], ["BABAB", "阿里巴巴"], ["GMEB", "GameStop"], ["NFLXB", "Netflix"],
  ["MSTRB", "Strategy"], ["DJTB", "特朗普传媒"], ["SOXSB", "半导体3倍做空"], ["SOXLB", "半导体3倍做多"],
  ["MRNAB", "Moderna"], ["FLNCB", "Fluence Energy"], ["BMNRB", "BitMine"], ["BNCB", "CEA Industries"],
  ["FXIon", "中国大盘ETF"], ["BILIon", "Bilibili"], ["SQQQB", "纳指3倍做空"], ["SMCIB", "超微电脑"],
  ["IRENB", "IREN"], ["ASMLB", "ASML"], ["ASTSB", "AST SpaceMobile"], ["COHRB", "Coherent"],
  ["CRDOB", "Credo"], ["USARB", "USA Rare Earth"], ["ALABB", "Astera Labs"], ["CRCLB", "Circle"],
  ["MUB", "美光"], ["SNDKB", "闪迪"], ["AMDB", "AMD"], ["EWYB", "韩国ETF"],
  ["INTCB", "英特尔"], ["LITEB", "Lumentum"], ["METAB", "Meta"], ["PLTRB", "Palantir"],
  ["BEB", "Bloom Energy"], ["AMZNB", "亚马逊"], ["DELLB", "戴尔"], ["AMATB", "应用材料"],
  ["PYPLB", "PayPal"], ["GSB", "高盛"], ["SMHB", "半导体ETF"], ["QCOMB", "高通"],
  ["COINB", "Coinbase"], ["WDCB", "西部数据"], ["GLWB", "康宁"], ["NBISB", "Nebius"],
  ["DRAMB", "DRAM"], ["CBRSB", "CBRS"], ["ARMB", "ARM"], ["AAOIB", "AAOI"],
  ["RKLBB", "Rocket Lab"], ["NOKB", "诺基亚"], ["TSMB", "台积电"], ["AVGOB", "博通"],
  ["MRVLB", "Marvell"], ["IBMB", "IBM"], ["KORUB", "韩国3倍做多"], ["AXTIB", "AXT"],
  ["CRWVB", "CRWV"], ["MUUB", "MUU"], ["MVLLB", "MVLL"], ["SNXXB", "SNXX"],
  ["INTWB", "INTW"], ["TQQQB", "纳指3倍做多"], ["QNTB", "QNT"], ["ORCLB", "甲骨文"],
  ["STXB", "希捷"], ["CRWDB", "CrowdStrike"],
];

const QUOTE_STABLES = [{ symbol: "BNB" }, { symbol: "USDT" }, { symbol: "USDC" }, { symbol: "MYX" }, { symbol: "USD1" }, { symbol: "SOL" }];
const QUOTE_STOCKS = STOCK_QUOTES.map(([symbol, name]) => ({ symbol, name }));

const QUOTE_DATA: Record<QuoteCat, { symbol: string; name?: string }[]> = {
  featured: [{ symbol: "BNB" }, { symbol: "USDT" }, { symbol: "USDC" }, { symbol: "MYX" }],
  all: [...QUOTE_STABLES, ...QUOTE_STOCKS],
  stocks: QUOTE_STOCKS,
  preipo: [],
};

const PROTECT_OPTIONS = [
  { label: "关闭", seconds: 0 },
  { label: "5 分钟", seconds: 300 },
  { label: "15 分钟", seconds: 900 },
  { label: "30 分钟", seconds: 1800 },
];

/** 税收分配预设模板（FLAP 税收模版思路）：一键设定分配比例 */
const DIST_PRESETS: { label: string; pcts: [number, number, number, number] }[] = [
  { label: "全归创作者", pcts: [100, 0, 0, 0] },
  { label: "全部分红", pcts: [0, 0, 100, 0] },
  { label: "全部销毁", pcts: [0, 100, 0, 0] },
  { label: "全部流动性", pcts: [0, 0, 0, 100] },
  { label: "四等分", pcts: [25, 25, 25, 25] },
];

export interface LaunchItem {
  ts: string;
  creator: string;
  token: string;
  name: string;
  symbol: string;
  meta: string;
}

export interface StockPool {
  symbol: string;
  name: string;
  quote: string;
  price: string;
  mc: string;
  vol24h: string;
  holders: string;
  liq: string;
  chg: string[];
  tag: string;
}

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default function LaunchCard() {
  const { address, isConnected } = useAppKitAccount();
  const appKit = useAppKit();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const logoFile = useRef<File | null>(null);

  const [tokenType, setTokenType] = useState<TokenType>("tax");
  const [quote, setQuote] = useState("BNB");
  const [quoteCat, setQuoteCat] = useState<QuoteCat>("featured");
  const [buyTax, setBuyTax] = useState(1);
  const [sellTax, setSellTax] = useState(1);
  const [protectSeconds, setProtectSeconds] = useState(0);

  // 税收分配（合计必须 100%）：创作者钱包 / 销毁 / 分红 / 流动性
  const [creatorPct, setCreatorPct] = useState(100);
  const [burnPct, setBurnPct] = useState(0);
  const [dividendPct, setDividendPct] = useState(0);
  const [liquidityPct, setLiquidityPct] = useState(0);
  const [taxWallet, setTaxWallet] = useState("");

  const [phase, setPhase] = useState<Phase>("idle");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ txHash: string; token: string; flapUrl: string } | null>(null);
  const busy = useRef(false);

  const isTax = tokenType === "tax";
  const showTurnstile = phase === "verify" || phase === "submitting";

  function resetSecurity() {
    busy.current = false;
    setTurnstileToken(null);
    setPhase("idle");
  }

  function handleLogo(file: File | null) {
    logoFile.current = file;
    setLogoPreview(file ? URL.createObjectURL(file) : null);
    resetSecurity();
  }

  /** 发币主流程：Turnstile → 提交给 Vortex 中继器 → 中继器代付 FLAP 创建费并上链 */
  async function launchCore(captcha: string | null) {
    if (busy.current || !address) return;
    setError(null);

    const trimmedName = name.trim();
    const trimmedSymbol = symbol.trim().toUpperCase();
    if (!trimmedName || trimmedName.length > 32) return setError("名称需 1–32 字符");
    if (!/^[A-Z0-9]{1,10}$/.test(trimmedSymbol)) return setError("符号需 1–10 位字母或数字");
    if (quote !== "BNB") return setError(`${quote} 计价即将支持，当前仅 BNB 计价`);
    if (isTax && creatorPct + burnPct + dividendPct + liquidityPct !== 100) {
      return setError("税收分配合计必须为 100%");
    }
    const taxWalletAddr = taxWallet.trim() === "" ? address : taxWallet.trim();
    if (!isAddress(taxWalletAddr)) return setError("接收钱包地址格式不正确");
    if (!captcha) {
      setPhase("verify"); // renders the Turnstile widget
      return;
    }

    busy.current = true;
    try {
      setPhase("submitting");
      const res = await fetch(`${RELAYER_URL}/api/launch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          symbol: trimmedSymbol,
          description,
          userAddress: address,
          tokenType,
          buyTaxPct: isTax ? buyTax : 0,
          sellTaxPct: isTax ? sellTax : 0,
          mktPct: isTax ? creatorPct : 0,
          deflationPct: isTax ? burnPct : 0,
          dividendPct: isTax ? dividendPct : 0,
          lpPct: isTax ? liquidityPct : 0,
          taxWallet: taxWalletAddr,
          protectSeconds,
          turnstileToken: captcha,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "代付网关拒绝了本次发射");

      setResult({ txHash: data.txHash, token: data.token, flapUrl: data.flapUrl ?? `https://flap.sh/bnb/${data.token}` });
      setName("");
      setSymbol("");
      setDescription("");
      handleLogo(null);
      setPhase("done");
    } catch (err) {
      console.error("[launch]", err);
      setError(err instanceof Error ? err.message : "Something went wrong");
      resetSecurity();
    } finally {
      busy.current = false;
    }
  }

  const inputCls =
    "mt-1.5 w-full rounded-md border border-[#3A4046] bg-[#131518] px-3.5 py-2.5 text-sm outline-none transition hover:border-[#4A5058] focus:border-[#E0A000]";
  const fieldCls = "text-xs text-gray-400";
  const sectionCls = "text-sm font-bold";

  return (
    <main
      className="min-h-screen bg-[#070808] text-[#F9FAFB] antialiased"
      style={{ fontFamily: "'Noto Sans SC', 'Space Grotesk', Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif", caretColor: ACCENT }}
    >
      {/* 顶部导航 */}
      <nav className="mx-auto flex h-16 max-w-[1440px] items-center gap-6 px-4 md:px-8">
        <a href="#" className="flex items-center gap-2">
          {/* 项目 LOGO：将 logo 文件放入 Next.js public/logo.png */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="VORTEX" className="h-8 w-8 object-contain" />
          <span className="text-lg font-bold tracking-widest">VORTEX</span>
        </a>
        <div className="hidden items-center gap-5 text-sm text-gray-300 md:flex">
          <a href="/" className="hover:text-white">首页</a>
          <span className="cursor-not-allowed text-gray-600" title="暂未开放">商店</span>
          <span className="cursor-not-allowed text-gray-600" title="暂未开放">锁仓</span>
          <a href="https://flap.sh" target="_blank" rel="noreferrer" className="hover:text-white">FLAP</a>
          {/* 白皮书路由：Next.js 中挂载 docs/白皮书.md 渲染的页面 */}
          <a href="/docs" className="hover:text-white">文档</a>
          {/* 捐赠独立页：app/donate/page.tsx 渲染 <DonateCard/> */}
          <a href="/donate" className="hover:text-white">捐赠</a>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button className="flex items-center gap-1.5 rounded-md border border-[#303236] bg-[#070808] px-3 py-1.5 text-sm">
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[#F0B90B] text-[9px] font-bold text-black">B</span>
            BSC
          </button>
          <a
            href="https://x.com/Vortex_flap"
            target="_blank"
            rel="noreferrer"
            title="X"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[#303236] bg-[#070808] text-gray-300 transition hover:border-[#E0A000] hover:text-white"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
          </a>
          {!isConnected ? (
            <button
              onClick={() => appKit.open()}
              className="rounded-md px-3 py-1.5 text-sm font-semibold text-black"
              style={{ background: ACCENT }}
            >
              连接钱包
            </button>
          ) : (
            <button className="rounded-md px-3 py-1.5 text-sm" style={{ background: "#070808", color: ACCENT, border: `1px solid ${ACCENT}` }}>
              {shortAddr(address)}
            </button>
          )}
        </div>
      </nav>

      {/* 英雄区 */}
      <div style={{ background: "radial-gradient(ellipse 55% 42% at 50% 0%, rgba(224,160,0,0.13), transparent 72%)" }}>
        <header className="mx-auto max-w-[1440px] px-4 pb-6 pt-10 text-center md:px-8">
          <p className="text-xs font-semibold uppercase tracking-[0.35em]" style={{ color: ACCENT }}>
            The FLAP Fee-Sponsor Launchpad on BSC
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" className="mx-auto mt-6 h-16 w-16 object-contain" />
          <h1 className="mt-4 text-5xl font-black tracking-tight md:text-7xl">VORTEX</h1>
          <p className="mt-4 text-lg text-gray-400">/// Zero Fee. Launch on FLAP.</p>
          <p className="mx-auto mt-3 max-w-xl text-sm text-gray-500">
            0 手续费发币。Vortex 代付 FLAP 创建手续费，一次提交，代币直接上线 FLAP —— 你无需支付哪怕 1 wei。
          </p>
        </header>
      </div>

      {/* 主区域：发币卡 + 实时看板 */}
      <section className="mx-auto grid max-w-[1440px] gap-8 px-4 pb-16 md:px-8 lg:grid-cols-[440px_1fr]">
        {/* 发币卡 */}
        <div className="h-fit rounded-xl border border-[#303236] bg-[#0B0C0C] p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold">创建代币</h2>
            <span className="rounded border px-2 py-0.5 text-[10px]" style={{ borderColor: ACCENT, color: ACCENT }}>
              0 手续费
            </span>
          </div>

          {/* 基本信息 */}
          <h3 className={`${sectionCls} mt-5`}>基本信息</h3>
          <label className="mt-3 block">
            <span className={fieldCls}>代币名称*</span>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                resetSecurity();
              }}
              placeholder="例如：Vortex Dog"
              className={inputCls}
            />
          </label>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <label className="block">
              <span className={fieldCls}>代币符号*</span>
              <input
                value={symbol}
                onChange={(e) => {
                  setSymbol(e.target.value);
                  resetSecurity();
                }}
                placeholder="VDG"
                className={`${inputCls} uppercase`}
              />
            </label>
            <label className="block">
              <span className={fieldCls}>封面图片 / Logo</span>
              <span className="mt-1.5 flex h-[46px] w-[92px] cursor-pointer items-center justify-center overflow-hidden rounded-md border border-dashed border-[#303236] bg-[#070808] text-center text-[10px] text-gray-500 transition hover:border-[#E0A000]">
                {logoPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={logoPreview} alt="logo preview" className="h-full w-full object-cover" />
                ) : (
                  "上传 PNG"
                )}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => handleLogo(e.target.files?.[0] ?? null)}
                />
              </span>
            </label>
          </div>
          <label className="mt-4 block">
            <span className={fieldCls}>代币描述</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="一句话介绍你的代币（写入 FLAP 元数据）"
              className={`${inputCls} resize-none`}
            />
          </label>

          {/* 发射模式 */}
          <h3 className={`${sectionCls} mt-5`}>发射模式</h3>
          <div className="mt-3 space-y-2">
            {MODE_CARDS.map((m) => {
              const selected = tokenType === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    setTokenType(m.id);
                    setError(null);
                  }}
                  className={`flex w-full items-center gap-3 rounded-md border bg-[#070808] p-3 text-left transition ${
                    selected ? "" : "border-[#303236] hover:border-[#E0A000]/50"
                  }`}
                  style={selected ? { borderColor: ACCENT, background: "rgba(224,160,0,0.05)" } : undefined}
                >
                  {/* 单选圆钮：明确的可选标识 */}
                  <span
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border"
                    style={{ borderColor: selected ? ACCENT : "#303236" }}
                  >
                    {selected && <span className="h-2 w-2 rounded-full" style={{ background: ACCENT }} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">{m.title}</span>
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-gray-500">{m.desc}</span>
                  </span>
                </button>
              );
            })}
          </div>

          {/* 支付代币（分类：精选/全部/股票代币/Pre-IPO） */}
          <h3 className={`${sectionCls} mt-5`}>支付代币*</h3>
          <div className="mt-3 flex items-center gap-4 text-sm">
            {QUOTE_CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setQuoteCat(c.id)}
                style={{ color: quoteCat === c.id ? ACCENT : "#484B51" }}
                className="transition"
              >
                {c.label}
              </button>
            ))}
          </div>
          {QUOTE_DATA[quoteCat].length === 0 ? (
            <p className="mt-2 text-[11px] text-gray-600">Pre-IPO 池即将开放</p>
          ) : (
            <div className="mt-3 flex max-h-[260px] flex-wrap gap-2 overflow-y-auto pr-1">
              {QUOTE_DATA[quoteCat].map((q) => {
                const selected = quote === q.symbol;
                const isStock = !!q.name;
                return (
                  <button
                    key={q.symbol}
                    type="button"
                    onClick={() => setQuote(q.symbol)}
                    className="rounded-[2px] border px-3 py-2 text-sm transition"
                    style={{
                      background: selected ? "rgba(224,160,0,0.05)" : "transparent",
                      borderColor: selected ? ACCENT : isStock ? "#303236" : "#84888C",
                      color: selected ? ACCENT : isStock ? "#9CA3AF" : "#FFFFFF",
                    }}
                  >
                    <span className="flex items-center gap-1.5">
                      {isStock && (
                        <span
                          className="flex h-5 w-5 items-center justify-center rounded-full border text-[9px] font-bold"
                          style={{ borderColor: selected ? ACCENT : "rgba(224,160,0,0.4)", color: ACCENT }}
                        >
                          {q.symbol[0]}
                        </span>
                      )}
                      {q.symbol}
                      {q.name && <span className="text-[10px] opacity-60">{q.name}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* 代币设置 */}
          <h3 className={`${sectionCls} mt-5`}>代币设置</h3>
          {!isTax ? (
            <p className="mt-3 rounded-md border border-[#303236] bg-[#070808] px-3.5 py-3 text-[11px] leading-relaxed text-gray-500">
              零税标准代币：无买卖税，联合曲线阶段后自动迁移 DEX（FLAP Standard Token）。
            </p>
          ) : (
            <>
              <div className="mt-3 space-y-4">
                <label className="block">
                  <span className="flex items-center justify-between text-xs text-gray-400">
                    <span>买入税率</span>
                    <span className="text-sm font-bold" style={{ color: ACCENT }}>{buyTax}%</span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={10}
                    step={1}
                    value={buyTax}
                    onChange={(e) => setBuyTax(Number(e.target.value))}
                    className="mt-1.5 w-full accent-[#E0A000]"
                  />
                  <span className="flex justify-between text-[10px] text-gray-600">
                    <span>0%</span><span>10%</span>
                  </span>
                </label>
                <label className="block">
                  <span className="flex items-center justify-between text-xs text-gray-400">
                    <span>卖出税率</span>
                    <span className="text-sm font-bold" style={{ color: ACCENT }}>{sellTax}%</span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={10}
                    step={1}
                    value={sellTax}
                    onChange={(e) => setSellTax(Number(e.target.value))}
                    className="mt-1.5 w-full accent-[#E0A000]"
                  />
                  <span className="flex justify-between text-[10px] text-gray-600">
                    <span>0%</span><span>10%</span>
                  </span>
                </label>
              </div>

              {/* 税收分配 */}
              <div className="mt-4 border-t border-[#1A1B1D] pt-4">
                <div className="flex items-center justify-between">
                  <span className={fieldCls}>税收分配（总分配必须为 100%）</span>
                  <span
                    className={`text-[11px] font-bold ${creatorPct + burnPct + dividendPct + liquidityPct === 100 ? "" : "text-red-400"}`}
                    style={creatorPct + burnPct + dividendPct + liquidityPct === 100 ? { color: ACCENT } : undefined}
                  >
                    未分配: {100 - creatorPct - burnPct - dividendPct - liquidityPct}%
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {DIST_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => {
                        setCreatorPct(p.pcts[0]);
                        setBurnPct(p.pcts[1]);
                        setDividendPct(p.pcts[2]);
                        setLiquidityPct(p.pcts[3]);
                      }}
                      className="rounded-[2px] border border-[#303236] px-2 py-1 text-[11px] text-gray-400 transition hover:border-[#E0A000]/60 hover:text-gray-200"
                    >
                      {p.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      setCreatorPct(100);
                      setBurnPct(0);
                      setDividendPct(0);
                      setLiquidityPct(0);
                    }}
                    className="ml-auto rounded-[2px] border border-[#303236] px-2 py-1 text-[11px] text-gray-500 hover:text-gray-300"
                  >
                    重置
                  </button>
                </div>

                <div className="mt-2 space-y-3">
                  {[
                    { label: "创作者钱包（开发者、营销等）", val: creatorPct, set: setCreatorPct },
                    { label: "销毁（减少供应量）", val: burnPct, set: setBurnPct },
                    { label: "分红（持有者奖励）", val: dividendPct, set: setDividendPct },
                    { label: "流动性（增加流动性）", val: liquidityPct, set: setLiquidityPct },
                  ].map((row) => (
                    <label key={row.label} className="block">
                      <span className="flex items-center justify-between text-xs text-gray-400">
                        <span>{row.label}</span>
                        <span className="text-sm font-bold" style={{ color: ACCENT }}>{row.val}%</span>
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={5}
                        value={row.val}
                        onChange={(e) => row.set(Number(e.target.value))}
                        className="mt-1 w-full accent-[#E0A000]"
                      />
                    </label>
                  ))}
                </div>

                {/* 佣金接收地址（FLAP commissionReceiver） */}
                <div className="mt-3">
                  <span className={fieldCls}>佣金接收地址（可选）</span>
                  <input
                    value={taxWallet}
                    onChange={(e) => setTaxWallet(e.target.value.trim())}
                    placeholder="0x…（留空则归你本人）"
                    className={inputCls}
                  />
                  <button
                    type="button"
                    onClick={() => setTaxWallet("0x217264D477fC576B2768E2EABE7e8408CB17F39F")}
                    className="mt-1.5 text-[11px] underline"
                    style={{ color: ACCENT }}
                  >
                    填入 Vortex 中继合约（佣金用于补贴平台 Gas）
                  </button>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-gray-500">
                    代币<b className="text-gray-300">税收主体</b>始终打入你的连接钱包（不受此地址影响）；此地址接收 FLAP 协议佣金，可用于补贴平台代付的 Gas。
                  </p>
                </div>
              </div>
            </>
          )}

          {/* 防挖提卖保护期 */}
          <div className="mt-4">
            <span className={fieldCls}>防「挖、提、卖」保护期</span>
            <div className="mt-2 flex flex-wrap gap-2">
              {PROTECT_OPTIONS.map((o) => {
                const selected = protectSeconds === o.seconds;
                return (
                  <button
                    key={o.seconds}
                    type="button"
                    onClick={() => setProtectSeconds(o.seconds)}
                    className="rounded-[2px] border px-3 py-1.5 text-xs transition"
                    style={
                      selected
                        ? { background: "rgba(224,160,0,0.05)", borderColor: ACCENT, color: ACCENT }
                        : { background: "transparent", borderColor: "#303236", color: "#9CA3AF" }
                    }
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </div>

          {showTurnstile ? (
            <div className="mt-4 rounded-md border border-[#303236] bg-[#070808] p-3.5">
              <Turnstile
                siteKey={TURNSTILE_SITE_KEY}
                options={{ theme: "dark", size: "flexible" }}
                onSuccess={(t) => {
                  setTurnstileToken(t);
                  launchCore(t);
                }}
                onError={() => setError("Human check failed — try again")}
                onExpire={() => setTurnstileToken(null)}
              />
            </div>
          ) : (
            <div className="mt-4 rounded-md border border-[#303236] bg-[#070808] p-3.5 text-center text-[11px] text-gray-500">
              Cloudflare Turnstile · 点击发币后自动验证
            </div>
          )}

          <button
            onClick={() => launchCore(turnstileToken)}
            disabled={!isConnected || phase === "submitting"}
            className="mt-4 w-full rounded-md py-3 text-sm font-bold text-black transition disabled:cursor-not-allowed disabled:opacity-50"
            style={{ background: ACCENT }}
          >
            {!isConnected
              ? "连接钱包后发币"
              : phase === "submitting"
                ? "代付上链中…"
                : "一键发币 · Launch on FLAP"}
          </button>
          <p className="mt-3 text-center text-[11px] leading-relaxed text-gray-500">
            0 手续费 · Vortex 代付 FLAP 创建费（约 0.001 BNB）· 代币上线 FLAP
          </p>

          {error && (
            <p className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-xs text-red-400">
              {error}
            </p>
          )}

          {result && phase === "done" && (
            <div className="mt-3 break-all rounded-md border px-3.5 py-3 text-xs text-gray-300" style={{ borderColor: `${ACCENT}66`, background: `${ACCENT}0D` }}>
              <p className="font-semibold" style={{ color: ACCENT }}>✓ 代币已上线 FLAP</p>
              <p className="mt-1">Token: {shortAddr(result.token)}</p>
              <p className="mt-0.5 text-gray-500">
                Tx: {shortAddr(result.txHash)} ·{" "}
                <a className="underline" href={`https://bscscan.com/tx/${result.txHash}`} target="_blank" rel="noreferrer">
                  BscScan ↗
                </a>
              </p>
              <a
                className="mt-2 block w-full rounded-md py-2.5 text-center text-sm font-bold text-black"
                style={{ background: ACCENT }}
                href={result.flapUrl}
                target="_blank"
                rel="noreferrer"
              >
                在 FLAP 查看代币 ↗
              </a>
            </div>
          )}
        </div>

        <LaunchFeed />
      </section>

      {/* 页脚 */}
      <footer className="border-t border-[#1A1B1D] py-8 text-center text-xs text-gray-600">
        <div className="flex flex-wrap items-center justify-center gap-5">
          <span className="cursor-not-allowed text-gray-700" title="暂未开放">条款与条件</span>
          <span className="cursor-not-allowed text-gray-700" title="暂未开放">联系我们</span>
          <a href="/docs" className="hover:text-gray-400">文档</a>
          <a href="https://flap.sh" target="_blank" rel="noreferrer" className="hover:text-gray-400">FLAP</a>
          <a href="https://x.com/Vortex_flap" target="_blank" rel="noreferrer" className="hover:text-gray-400">X</a>
        </div>
        <p className="mt-3">Vortex · The FLAP Fee-Sponsor Launchpad on BSC</p>
      </footer>
    </main>
  );
}

const BOARD_TABS = ["热门", "内盘打新", "股票", "礼物代币", "创新", "低风险 FAC"] as const;

const th = "px-3 py-2.5 text-right font-normal";
const td = "px-3 py-3 text-right text-gray-400";
const chgCls = (v: string) => (v.startsWith("+") ? "text-green-400" : "text-red-400");

function TokenRow({ l }: { l: LaunchItem }) {
  return (
    <tr className="border-b border-[#1A1B1D] hover:bg-white/[0.02]">
      <td className="px-3 py-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#E0A000] text-xs font-bold text-black">
            {l.symbol[0] ?? "?"}
          </span>
          <div className="leading-tight">
            <div className="font-semibold">${l.symbol}</div>
            <div className="text-xs text-gray-500">{l.name}</div>
          </div>
        </div>
      </td>
      <td className={td}>—</td>
      <td className={td}>BNB</td>
      <td className={td}>—</td>
      <td className={td}>—</td>
      <td className={td}>—</td>
      <td className={td}>—</td>
      <td className={td}>—</td>
      <td className={td}>—</td>
      <td className={td}>—</td>
      <td className={td}>—</td>
      <td className={td}>
        <a
          href={`https://flap.sh/bnb/${l.token}`}
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-gray-200"
        >
          FLAP ↗
        </a>
      </td>
    </tr>
  );
}

function StockRow({ s }: { s: StockPool }) {
  return (
    <tr className="border-b border-[#1A1B1D] hover:bg-white/[0.02]">
      <td className="px-3 py-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#E0A000]/40 bg-[#E0A000]/10 text-xs font-bold" style={{ color: ACCENT }}>
            {s.symbol[0]}
          </span>
          <div className="leading-tight">
            <div className="flex items-center gap-1.5 font-semibold">
              ${s.symbol}
              <span className="rounded-sm px-1 text-[9px] font-bold text-black" style={{ background: ACCENT }}>{s.tag}</span>
            </div>
            <div className="text-xs text-gray-500">{s.name}</div>
          </div>
        </div>
      </td>
      <td className="px-3 py-3 text-right">{s.price}</td>
      <td className={td}>{s.quote}</td>
      <td className="px-3 py-3 text-right">{s.mc}</td>
      <td className={td}>0%/0%</td>
      <td className="px-3 py-3 text-right">{s.vol24h}</td>
      <td className="px-3 py-3 text-right">{s.holders}</td>
      <td className={td}>{s.liq}</td>
      {s.chg.map((v, i) => (
        <td key={i} className={`px-3 py-3 text-right ${chgCls(v)}`}>{v}</td>
      ))}
      <td className={td}>
        <span className="cursor-not-allowed text-gray-600">底池详情（暂未开放）</span>
      </td>
    </tr>
  );
}

/** FLAP 风格实时看板：分类标签（含股票底池）+ 列表/网格切换 + 代币行情表。 */
export function LaunchFeed() {
  const [items, setItems] = useState<LaunchItem[]>([]);
  const [stocks, setStocks] = useState<StockPool[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"list" | "grid">("list");
  const [tab, setTab] = useState<(typeof BOARD_TABS)[number]>("热门");

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const [launchesRes, stocksRes] = await Promise.all([
          fetch(`${RELAYER_URL}/api/launches`),
          fetch(`${RELAYER_URL}/api/stocks`),
        ]);
        const launchesData = await launchesRes.json();
        const stocksData = await stocksRes.json();
        if (alive) {
          if (launchesData.ok) setItems(launchesData.launches ?? []);
          if (stocksData.ok) setStocks(stocksData.pools ?? []);
        }
      } catch {
        // relayer offline — keep the last frame
      } finally {
        if (alive) setLoading(false);
      }
    }
    poll();
    const id = setInterval(poll, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const tabCls = (t: string) =>
    t === tab
      ? "rounded-md px-3 py-1.5 text-sm font-semibold text-black"
      : "rounded-md border border-[#303236] bg-[#070808] px-3 py-1.5 text-sm text-gray-300 hover:text-white";

  const toggleCls = (v: "list" | "grid") =>
    view === v
      ? "rounded-md px-2.5 py-1.5 text-sm font-semibold text-black"
      : "rounded-md border border-[#303236] px-2.5 py-1.5 text-sm text-gray-300 hover:text-white";

  const isStocks = tab === "股票";
  const rows: (LaunchItem | StockPool)[] = isStocks ? stocks : items;

  // 价格/交易额/持有人等列需要 Subgraph 或链上索引，接入前显示占位符。
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        {BOARD_TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={tabCls(t)} style={t === tab ? { background: ACCENT } : undefined}>
            {t}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setView("list")} className={toggleCls("list")} style={view === "list" ? { background: ACCENT } : undefined}>
            列表
          </button>
          <button onClick={() => setView("grid")} className={toggleCls("grid")} style={view === "grid" ? { background: ACCENT } : undefined}>
            网格
          </button>
          <button className="rounded-md border border-[#303236] px-2.5 py-1.5 text-sm text-gray-300">筛选</button>
        </div>
      </div>

      {view === "list" ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[1080px] border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500">
                <th className="px-3 py-2.5 font-normal">代币</th>
                <th className={th}>价格</th>
                <th className={th}>计价代币</th>
                <th className={th}>市值</th>
                <th className={th}>税收</th>
                <th className={th}>24h 交易额</th>
                <th className={th}>持有人</th>
                <th className={th}>LIQ</th>
                <th className={th}>5M</th>
                <th className={th}>1H</th>
                <th className={th}>4H</th>
                <th className={th}>24H</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={12} className="px-3 py-10 text-center text-xs text-gray-500">
                    {loading ? "Loading…" : isStocks ? "股票底池接入中…" : "暂无代币 —— 成为第一个发币的人"}
                  </td>
                </tr>
              ) : isStocks ? (
                (rows as StockPool[]).map((s) => <StockRow key={s.symbol} s={s} />)
              ) : (
                (rows as LaunchItem[]).slice(0, 12).map((l) => <TokenRow key={l.token} l={l} />)
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
          {rows.length === 0 ? (
            <p className="col-span-full rounded-xl border border-[#303236] bg-[#0B0C0C] py-10 text-center text-xs text-gray-500">
              {loading ? "Loading…" : "暂无数据"}
            </p>
          ) : isStocks ? (
            (rows as StockPool[]).map((s) => (
              <a
                key={s.symbol}
                href="#"
                className="rounded-xl border border-[#303236] bg-[#0B0C0C] p-4 transition hover:border-[#E0A000]/50"
              >
                <div className="flex items-center gap-2.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#E0A000]/40 bg-[#E0A000]/10 text-xs font-bold" style={{ color: ACCENT }}>
                    {s.symbol[0]}
                  </span>
                  <div className="min-w-0 leading-tight">
                    <div className="flex items-center gap-1.5 font-semibold">
                      ${s.symbol}
                      <span className="rounded-sm px-1 text-[9px] font-bold text-black" style={{ background: ACCENT }}>{s.tag}</span>
                    </div>
                    <div className="truncate text-xs text-gray-500">{s.name}</div>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 border-t border-[#1A1B1D] pt-3 text-center text-[11px]">
                  <div>
                    <div className="text-gray-500">价格</div>
                    <div className="mt-0.5">{s.price}</div>
                  </div>
                  <div>
                    <div className="text-gray-500">24h 交易额</div>
                    <div className="mt-0.5">{s.vol24h}</div>
                  </div>
                  <div>
                    <div className="text-gray-500">24H</div>
                    <div className={`mt-0.5 ${chgCls(s.chg[3])}`}>{s.chg[3]}</div>
                  </div>
                </div>
              </a>
            ))
          ) : (
            (rows as LaunchItem[]).slice(0, 12).map((l) => (
              <a
                key={l.token}
                href={`https://flap.sh/bnb/${l.token}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-xl border border-[#303236] bg-[#0B0C0C] p-4 transition hover:border-[#E0A000]/50"
              >
                <div className="flex items-center gap-2.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#E0A000] text-xs font-bold text-black">
                    {l.symbol[0] ?? "?"}
                  </span>
                  <div className="min-w-0 leading-tight">
                    <div className="truncate font-semibold">${l.symbol}</div>
                    <div className="truncate text-xs text-gray-500">{l.name}</div>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 border-t border-[#1A1B1D] pt-3 text-[11px]">
                  <div>
                    <div className="text-gray-500">创建者</div>
                    <div className="mt-0.5">{shortAddr(l.creator)}</div>
                  </div>
                  <div>
                    <div className="text-gray-500">上线</div>
                    <div className="mt-0.5">FLAP ↗</div>
                  </div>
                </div>
              </a>
            ))
          )}
        </div>
      )}
    </div>
  );
}
