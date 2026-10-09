"use client";

import { createAppKit } from "@reown/appkit/react";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { WagmiProvider } from "wagmi";
import { bsc, bscTestnet } from "wagmi/chains";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Reown AppKit（原 WalletConnect Web3Modal）：扫码 + 插件钱包多端连接
 * 使用前到 https://cloud.reown.com 免费注册项目，拿到 Project ID 填入
 * NEXT_PUBLIC_REOWN_PROJECT_ID（.env.local）。
 */
const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? "";

const wagmiAdapter = new WagmiAdapter({
  networks: [bsc, bscTestnet],
  projectId,
  ssr: true,
});

createAppKit({
  adapters: [wagmiAdapter],
  networks: [bsc, bscTestnet],
  projectId,
  metadata: {
    name: "Vortex",
    description: "The FLAP Fee-Sponsor Launchpad on BSC",
    url: "https://vortex.example.com", // 替换为正式域名
    icons: ["/logo.png"],
  },
  features: { analytics: true },
  themeVariables: {
    "--w3m-accent": "#E0A000",
    "--w3m-color-mix": "#E0A000",
    "--w3m-color-mix-strength": 20,
  },
});

const queryClient = new QueryClient();

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={wagmiAdapter.wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
