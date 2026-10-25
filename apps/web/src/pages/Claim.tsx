import { BalanceList } from "../components/Balances";

export function ClaimPage() {
  return (
    <div className="stack">
      <header className="page-head">
        <h1>Payments waiting for you</h1>
        <p className="muted">
          Claim before the deadline. If your account can't hold the asset yet, the same transaction adds the trustline
          first.
        </p>
      </header>
      <BalanceList role="recipient" />
    </div>
  );
}
