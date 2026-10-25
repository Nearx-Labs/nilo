import { BalanceList } from "../components/Balances";
import { HowItWorks } from "../components/HowItWorks";

const STEPS = [
  { title: "You send a payment", text: "It waits on the network until someone claims it." },
  { title: "The recipient claims it", text: "They can claim it any time before the deadline you set." },
  { title: "Unclaimed? It comes back", text: "After the deadline, only you can recover it here." },
];

export function SentPage() {
  return (
    <div className="stack page-wide">
      <header className="page-head">
        <span className="eyebrow">Sent</span>
        <h1>
          Payments <span className="accent-word">you</span> sent
        </h1>
        <p className="muted">
          <strong className="lead">Nothing gets lost.</strong> Anything not claimed before its deadline can be recovered
          here.
        </p>
      </header>
      <BalanceList role="sender" />
      <HowItWorks steps={STEPS} />
    </div>
  );
}
