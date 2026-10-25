import { BalanceList } from "../components/Balances";

export function SentPage() {
  return (
    <div className="stack">
      <h2>Payments you sent</h2>
      <p className="muted">Anything not claimed before its deadline can be recovered here.</p>
      <BalanceList role="sender" />
    </div>
  );
}
