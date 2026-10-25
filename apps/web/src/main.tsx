import { PollarProvider } from "@pollar/react";
import "@pollar/react/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import { BotsProvider, DEFAULT_BOT, useBots } from "./bots/store";
import { Shell } from "./components/Layout";
import { ClaimPage } from "./pages/Claim";
import { ChatPage } from "./pages/Send";
import { SentPage } from "./pages/Sent";
import "./styles.css";

const POLLAR_API_KEY = import.meta.env.VITE_POLLAR_API_KEY as string | undefined;
// Module scope: the provider locks the client config at first render.
const POLLAR_CLIENT = {
  apiKey: POLLAR_API_KEY ?? "",
  stellarNetwork: "testnet" as const,
  // Dev: log every auth/tx step to the console to debug login.
  logLevel: import.meta.env.DEV ? ("debug" as const) : undefined,
};

const HOME = `/chat/${DEFAULT_BOT.id}`;

function ChatRoute() {
  const { botId } = useParams();
  const bot = useBots().getBot(botId);
  if (!bot) return <Navigate to={HOME} replace />;
  // Keyed so switching bots starts from that bot's own state.
  return <ChatPage key={bot.id} bot={bot} />;
}

function App() {
  if (!POLLAR_API_KEY) {
    return (
      <main className="main fatal">
        <p className="error">Set VITE_POLLAR_API_KEY in the repository's .env file and restart the dev server.</p>
      </main>
    );
  }
  return (
    <PollarProvider client={POLLAR_CLIENT}>
      <BotsProvider>
        <BrowserRouter>
          <Shell>
            <Routes>
              <Route path="/chat/:botId" element={<ChatRoute />} />
              <Route path="/claim" element={<ClaimPage />} />
              <Route path="/sent" element={<SentPage />} />
              <Route path="/send" element={<Navigate to={HOME} replace />} />
              <Route path="*" element={<Navigate to={HOME} replace />} />
            </Routes>
          </Shell>
        </BrowserRouter>
      </BotsProvider>
    </PollarProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
