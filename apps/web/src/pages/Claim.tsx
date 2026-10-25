import { BalanceList } from "../components/Balances";

export function ClaimPage() {
  return (
    <div className="stack">
      <h2>Payments waiting for you</h2>
      <p className="muted">
        Claim before the deadline. If your account can't hold the asset yet, the same transaction adds the trustline
        first.
      </p>
      <BalanceList role="recipient" />
    </div>
  );
}
