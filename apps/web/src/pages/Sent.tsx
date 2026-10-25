import { BalanceList } from "../components/Balances";

export function SentPage() {
  return (
    <div className="stack">
      <header className="page-head">
        <h1>Payments you sent</h1>
        <p className="muted">Anything not claimed before its deadline can be recovered here.</p>
      </header>
      <BalanceList role="sender" />
    </div>
  );
}
