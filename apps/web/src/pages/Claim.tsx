import { BalanceList } from "../components/Balances";
import { ChevronIcon, InfoIcon } from "../components/icons";

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
      <section className="panel how">
        <h2>
          <InfoIcon width={16} height={16} /> How it works
        </h2>
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <span className="step-num">{i + 1}</span>
              <div>
                <strong>{s.title}</strong>
                <p>{s.text}</p>
              </div>
              {i < STEPS.length - 1 && <ChevronIcon className="step-arrow" width={16} height={16} />}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
