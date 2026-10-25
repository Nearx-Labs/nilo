import { BalanceList } from "../components/Balances";
import { HowItWorks } from "../components/HowItWorks";

const STEPS = [
  { title: "Someone sends you a payment", text: "The transaction is detected on the network." },
  { title: "We check your account", text: "If the asset isn't available yet, we add the trustline first." },
  { title: "You claim it", text: "The funds are ready in your account, safely and securely." },
];

export function ClaimPage() {
  return (
    <div className="stack page-wide">
      <header className="page-head">
        <span className="eyebrow">Claim</span>
        <h1>
          Payments waiting for <span className="accent-word">you</span>
        </h1>
        <p className="muted">
          <strong className="lead">Claim before the deadline.</strong> If your account can't hold the asset yet, the
          same transaction adds the trustline first.
        </p>
      </header>
      <BalanceList role="recipient" />
      <HowItWorks steps={STEPS} />
    </div>
  );
}
