"use client";

import { useEffect, useState } from "react";
import { formatEther } from "viem";
import { parseEther, type Address } from "viem";
import { useSendTransaction } from "wagmi";
import { useAppKit, useAppKitAccount } from "@reown/appkit/react";

/**
 * 开发者互助基金 — 独立捐赠页组件（挂载到 app/donate/page.tsx）
 * 成功 DEV 自愿捐赠，供养后续创业者的 FLAP 创建费。
 */
const ACCENT = "var(--vortex-accent, #E0A000)";

const FUND_ADDRESS = (process.env.NEXT_PUBLIC_FUND_ADDRESS ?? "") as string;
const DONATE_PRESETS = ["0.01", "0.05", "0.1", "0.5"];

const RELAYER_URL = process.env.NEXT_PUBLIC_RELAYER_URL ?? "http://localhost:8080";

interface WallEntry {
  name: string;
  logo: string;
  donor: string;
  value: string;
  txHash: string;
  ts: number;
}

export default function DonateCard() {
  const { isConnected } = useAppKitAccount();
  const appKit = useAppKit();
  const { sendTransaction, isPending } = useSendTransaction();

  const [amount, setAmount] = useState("0.01");
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // 荣誉墙：项目名称 + Logo
  const [projectName, setProjectName] = useState("");
  const [projectLogo, setProjectLogo] = useState(""); // dataURL
  const [wall, setWall] = useState<WallEntry[]>([]);

  useEffect(() => {
    let alive = true;
    fetch(`${RELAYER_URL}/api/donations`)
      .then((r) => r.json())
      .then((d) => { if (alive && d.ok && d.donations?.length) setWall(d.donations); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  function handleLogo(file: File | null) {
    if (!file || file.size > 150 * 1024) return;
    const reader = new FileReader();
    reader.onload = () => setProjectLogo(String(reader.result || ""));
    reader.readAsDataURL(file);
  }

  return (
    <main
      className="min-h-screen bg-[#070808] text-[#F9FAFB] antialiased"
      style={{ fontFamily: "'Noto Sans SC', 'Space Grotesk', Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif" }}
    >
      <nav className="mx-auto flex h-16 max-w-[960px] items-center gap-6 px-4 md:px-8">
        <a href="/" className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="VORTEX" className="h-8 w-8 object-contain" />
          <span className="text-lg font-bold tracking-widest">VORTEX</span>
        </a>
        <div className="hidden items-center gap-5 text-sm text-gray-300 md:flex">
          <a href="/" className="hover:text-white">首页</a>
          <a href="/docs" className="hover:text-white">文档</a>
          <a href="/donate" style={{ color: ACCENT }}>捐赠</a>
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
        </div>
      </nav>

      <div style={{ background: "radial-gradient(ellipse 55% 42% at 50% 0%, rgba(224,160,0,0.13), transparent 72%)" }}>
        <header className="mx-auto max-w-[960px] px-4 pb-8 pt-12 text-center md:px-8">
          <p className="text-xs font-semibold uppercase tracking-[0.35em]" style={{ color: ACCENT }}>Vortex Dev Fund</p>
          <h1 className="mt-4 text-4xl font-black tracking-tight md:text-5xl">开发者互助基金</h1>
          <p className="mt-4 text-base text-gray-400">今天你被扶持，明天你扶持别人。</p>
        </header>
      </div>

      <section className="mx-auto max-w-[560px] px-4 pb-16 md:px-8">
        <div className="rounded-xl border border-dashed p-6" style={{ borderColor: ACCENT }}>
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold">自愿捐赠</h2>
            <span className="rounded border px-2 py-0.5 text-[10px]" style={{ borderColor: ACCENT, color: ACCENT }}>
              自愿 · 公开 · 零强制
            </span>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-gray-300">
            每一位成功上线的 DEV，都可以自愿留下一份发射成本，让下一位创业者继续零成本出发。
          </p>
          <p className="mt-4 text-[11px] leading-relaxed text-gray-500">
            捐款直接进入发射金库，用于代付后续创业者的 FLAP 创建费。全部链上公开可查，不强制、不抽成、不设最低门槛，也不承诺任何回报。
          </p>

          {FUND_ADDRESS ? (
            <div className="mt-5 rounded-md border border-[#303236] bg-[#070808] px-3.5 py-3">
              <p className="text-[11px] text-gray-500">基金收款地址（BSC）</p>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="min-w-0 break-all text-xs text-gray-400">{FUND_ADDRESS}</span>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(FUND_ADDRESS);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                  className="shrink-0 rounded-md border border-[#303236] px-2 py-1 text-[11px] text-gray-400 transition hover:border-[#E0A000]"
                >
                  {copied ? "已复制" : "复制地址"}
                </button>
              </div>
            </div>
          ) : (
            <p className="mt-5 rounded-md border border-[#303236] bg-[#070808] px-3.5 py-3 text-[11px] text-gray-500">
              基金地址待配置（.env.local: NEXT_PUBLIC_FUND_ADDRESS）
            </p>
          )}

          <label className="mt-5 block">
            <span className="text-xs text-gray-400">项目名称（荣誉墙展示）</span>
            <input
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              maxLength={32}
              placeholder="你的代币或项目名，如：币安公主"
              className="mt-1.5 w-full rounded-md border border-[#3A4046] bg-[#131518] px-3.5 py-2.5 text-sm outline-none transition hover:border-[#4A5058] focus:border-[#E0A000]"
            />
          </label>

          <label className="mt-4 block cursor-pointer">
            <span className="text-xs text-gray-400">项目 LOGO（选填，不上传则用首字母头像）</span>
            <span className="mt-1.5 flex h-16 w-16 cursor-pointer items-center justify-center overflow-hidden rounded-md border border-dashed border-[#303236] bg-[#070808] text-center text-[10px] text-gray-500 transition hover:border-[#E0A000]">
              {projectLogo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={projectLogo} alt="logo" className="h-full w-full object-cover" />
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

          <div className="mt-4 flex flex-wrap gap-2">
            {DONATE_PRESETS.map((amt) => {
              const selected = amount === amt;
              return (
                <button
                  key={amt}
                  type="button"
                  onClick={() => setAmount(amt)}
                  className="rounded-[2px] border px-3 py-1.5 text-xs transition"
                  style={
                    selected
                      ? { background: "rgba(224,160,0,0.05)", borderColor: ACCENT, color: ACCENT }
                      : { background: "transparent", borderColor: "#303236", color: "#9CA3AF" }
                  }
                >
                  {amt} BNB
                </button>
              );
            })}
          </div>

          <button
            type="button"
            disabled={isPending || !FUND_ADDRESS}
            onClick={() => {
              setMsg(null);
              if (!isConnected) {
                appKit.open();
                setMsg("请先连接钱包。捐款是自愿的：成功后回馈一次发射成本，帮下一位创业者零成本出发。");
                return;
              }
              try {
                sendTransaction(
                  { to: FUND_ADDRESS as Address, value: parseEther(amount) },
                  {
                    onSuccess: (txHash) => {
                      setMsg(`感谢你的捐赠。下一枚 0 手续费代币背后，有你的一份燃料。 Tx: ${txHash.slice(0, 10)}…${txHash.slice(-6)}`);
                      if (projectName.trim()) {
                        fetch(`${RELAYER_URL}/api/donations`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ name: projectName.trim(), logo: projectLogo, txHash, donor: address }),
                        })
                          .then((r) => r.json())
                          .then((d) => {
                            if (d.ok) {
                              setMsg((m) => (m ? m.replace("燃料。", "燃料。已登上荣誉墙") : m));
                              setWall((w) => [d.entry, ...w]);
                            }
                          })
                          .catch(() => {});
                      }
                    },
                    onError: () => setMsg("交易未完成（可能被钱包拒绝）。捐赠纯属自愿，随时可以再来。"),
                  }
                );
              } catch {
                setMsg("金额格式有误，请重新选择。");
              }
            }}
            className="mt-5 w-full rounded-md py-3 text-sm font-bold text-black transition disabled:cursor-not-allowed disabled:opacity-50"
            style={{ background: ACCENT }}
          >
            {isPending ? "转账中…" : "捐款支持"}
          </button>
          {msg && (
            <p className="mt-4 rounded-md border px-3.5 py-3 text-xs leading-relaxed text-gray-300" style={{ borderColor: `${ACCENT}66`, background: `${ACCENT}0D` }}>
              {msg}
            </p>
          )}
        </div>

        <div className="mt-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold">荣誉墙</h2>
            <span className="rounded border px-2 py-0.5 text-[10px]" style={{ borderColor: ACCENT, color: ACCENT }}>Honor Wall</span>
          </div>
          <p className="mt-2 text-xs text-gray-500">每一位捐赠者，都会被记录在这里。链上核验，公开可见。</p>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
            {wall.length === 0 ? (
              <p className="col-span-full rounded-xl border border-[#303236] bg-[#0B0C0C] py-10 text-center text-xs text-gray-500">
                暂无捐赠记录 —— 成为第一位上榜的 DEV
              </p>
            ) : (
              wall.slice(0, 12).map((d) => (
                <div key={d.txHash} className="rounded-xl border border-[#303236] bg-[#0B0C0C] p-4">
                  <div className="flex items-center gap-3">
                    {d.logo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={d.logo} alt="" className="h-10 w-10 rounded-full object-cover" />
                    ) : (
                      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#E0A000] text-sm font-bold text-black">
                        {(d.name[0] || "?").toUpperCase()}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{d.name}</p>
                      <p className="mt-0.5 text-[11px] text-gray-500">{d.donor.slice(0, 6)}…{d.donor.slice(-4)}</p>
                    </div>
                    <span className="shrink-0 text-sm font-bold" style={{ color: ACCENT }}>
                      {(() => { try { return Number(formatEther(BigInt(d.value))).toFixed(2) + " BNB"; } catch { return "—"; } })()}
                    </span>
                  </div>
                  <a
                    href={`https://bscscan.com/tx/${d.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 block text-right text-[10px] text-gray-600 underline hover:text-gray-400"
                  >
                    交易凭证 ↗
                  </a>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="mt-6 rounded-xl border border-[#303236] bg-[#0B0C0C] p-6">
          <h3 className="text-sm font-bold">常见问题</h3>
          <div className="mt-3 space-y-3 text-xs leading-relaxed text-gray-500">
            <p><span className="text-gray-300">钱去哪里？</span> 进入 Vortex 发射金库，专用于代付后续创业者的 FLAP 创建费，链上公开可查。</p>
            <p><span className="text-gray-300">必须捐吗？</span> 纯属自愿。不捐不影响你发币，也不影响你的代币交易。</p>
            <p><span className="text-gray-300">捐了有回报吗？</span> 没有。你得到的是下一位 DEV 零成本出发的机会。</p>
            <p><span className="text-gray-300">怎么上荣誉墙？</span> 捐款时填写项目名称与 Logo，交易经链上核验后自动上榜，所有人可见。</p>
          </div>
        </div>
      </section>

      <footer className="border-t border-[#1A1B1D] py-8 text-center text-xs text-gray-600">
        <p>Vortex · The FLAP Fee-Sponsor Launchpad on BSC · <a href="https://x.com/Vortex_flap" target="_blank" rel="noreferrer" className="underline">X</a></p>
      </footer>
    </main>
  );
}
