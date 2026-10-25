import { BalanceList } from "../components/Balances";
import { HowItWorks } from "../components/HowItWorks";
import { InboxIcon } from "../components/icons";
import { PageTop } from "../components/Layout";

const STEPS = [
  { title: "Someone sends you a payment", text: "The transaction is detected on the network." },
  { title: "We check your account", text: "If the asset isn't available yet, we add the trustline first." },
  { title: "You claim it", text: "The funds are ready in your account, safely and securely." },
];

export function ClaimPage() {
  return (
    <div className="view">
      <PageTop
        avatar={
          <span className="row-avatar tone-green mini">
            <InboxIcon width={16} height={16} />
          </span>
        }
        title="Claim"
      />
      <div className="view-scroll">
        <div className="page stack">
          <p className="intro">
            <strong>Payments waiting for you.</strong> Claim before the deadline. If your account can't hold the asset
            yet, the same transaction adds the trustline first.
          </p>
          <BalanceList role="recipient" />
          <HowItWorks steps={STEPS} />
        </div>
      </div>
    </div>
  );
}
