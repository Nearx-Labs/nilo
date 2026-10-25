import { PollarProvider, WalletButton } from "@pollar/react";
import "@pollar/react/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Navigate, Route, Routes } from "react-router-dom";
import { ClaimPage } from "./pages/Claim";
import { SendPage } from "./pages/Send";
import { SentPage } from "./pages/Sent";
import { useWallet } from "./wallet";
import "./styles.css";

function Header() {
  const { error } = useWallet();
  return (
    <header className="top">
      <div className="brand">
        <span className="logo">●●</span> Nilo <span className="net">testnet</span>
      </div>
      <nav>
        <NavLink to="/send">Send</NavLink>
        <NavLink to="/claim">Claim</NavLink>
        <NavLink to="/sent">Sent</NavLink>
      </nav>
      <div className="wallet">
        <WalletButton />
        {error && <span className="error small">{error}</span>}
      </div>
    </header>
  );
}

const POLLAR_API_KEY = import.meta.env.VITE_POLLAR_API_KEY as string | undefined;
// Module scope: the provider locks the client config at first render.
const POLLAR_CLIENT = {
  apiKey: POLLAR_API_KEY ?? "",
  stellarNetwork: "testnet" as const,
  // Dev: log every auth/tx step to the console to debug login.
  logLevel: import.meta.env.DEV ? ("debug" as const) : undefined,
};

function App() {
  if (!POLLAR_API_KEY) {
    return (
      <main>
        <p className="error">Set VITE_POLLAR_API_KEY in the repository's .env file and restart the dev server.</p>
      </main>
    );
  }
  return (
    <PollarProvider client={POLLAR_CLIENT}>
      <BrowserRouter>
        <Header />
        <main>
          <Routes>
            <Route path="/send" element={<SendPage />} />
            <Route path="/claim" element={<ClaimPage />} />
            <Route path="/sent" element={<SentPage />} />
            <Route path="*" element={<Navigate to="/send" replace />} />
          </Routes>
        </main>
      </BrowserRouter>
    </PollarProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
