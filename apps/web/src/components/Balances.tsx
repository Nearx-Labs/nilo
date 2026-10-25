import {
  type BalanceView,
  type Explanation,
  type HorizonClaimableBalance,
  buildClaimTx,
  canAffordTrustline,
  fromStroops,
  hasTrustline,
  toStroops,
  viewBalance,
} from "@nilo/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { asSnapshot, config, friendbot, horizon, loadAccount, requestSponsoredClaim } from "../stellar";
import { formatLocal, formatRelative, short, useNow } from "../time";
import { useWallet } from "../wallet";
import { EmptyWallet } from "./EmptyWallet";
import { RefreshIcon } from "./icons";
import { type Prepared, SignPanel } from "./SignPanel";

/** Ledger close times can trail the local clock by a few seconds. */
const CLOCK_MARGIN = 5;
/** How often the list reloads from Horizon on its own, so new payments show up without a click. */
const POLL_MS = 15_000;

export function useBalances(address: string | null) {
  const [records, setRecords] = useState<HorizonClaimableBalance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    try {
      const page = await horizon.claimableBalances().claimant(address).limit(100).order("desc").call();
      setRecords(page.records as unknown as HorizonClaimableBalance[]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [address]);
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);
  return { records, error, loading, refresh };
}

const STATUS_TEXT: Record<BalanceView["status"], string> = {
  claimable: "You can claim this now.",
  expired: "The deadline passed. Only the sender can recover these funds now.",
  recoverable: "Nobody claimed it before the deadline. You can recover it.",
  waiting: "Waiting for the recipient.",
};

export function BalanceList({ role }: { role: BalanceView["role"] }) {
  const { address, connect, error: walletError } = useWallet();
  const [funding, setFunding] = useState(false);
  const { records, error, loading, refresh } = useBalances(address);
  const now = useNow();
  const [active, setActive] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const views = useMemo(
    () =>
      address
        ? records.map((r) => viewBalance(r, address, now)).filter((v): v is BalanceView => v?.role === role)
        : [],
    [records, address, now, role],
  );

  if (!address)
    return (
      <div className="panel">
        <button onClick={connect}>Sign in</button>
        {walletError && <p className="error">{walletError}</p>}
      </div>
    );

  return (
    <div className="stack">
      <div className="row">
        <button
          className="connected"
          onClick={refresh}
          disabled={loading}
          title="Connected. The list refreshes on its own; click to refresh now."
        >
          <RefreshIcon width={16} height={16} className={loading ? "spin" : undefined} /> Connected
        </button>
        <span className="muted small">as {short(address)}</span>
      </div>
      {error && <p className="error">{error}</p>}
      <AccountCheck address={address} funding={funding} setFunding={setFunding} onFunded={refresh} />
      {message && <p className="success">{message}</p>}
      {views.length === 0 && !(loading && records.length === 0) && (
        <div className="panel empty">
          <EmptyWallet />
          <strong>{role === "recipient" ? "No pending payments for you." : "No pending payments you sent."}</strong>
          <p className="muted">
            {role === "recipient"
              ? "When someone sends you a payment, it will appear here and you'll be able to claim it."
              : "When you send a payment, it stays here until it is claimed or you recover it."}
          </p>
        </div>
      )}
      {views.map((v) => (
        <BalanceRow
          key={v.id}
          view={v}
          now={now}
          address={address}
          active={active === v.id}
          onMessage={setMessage}
          onOpen={() => {
            setMessage(null);
            setActive(v.id);
          }}
          onClose={() => setActive(null)}
          onDone={() => {
            setMessage(role === "recipient" ? "Claimed. The funds are in your account." : "Recovered. The funds are back in your account.");
            setActive(null);
            refresh();
          }}
        />
      ))}
    </div>
  );
}

function BalanceRow(props: {
  view: BalanceView;
  now: number;
  address: string;
  active: boolean;
  onOpen: () => void;
  onClose: () => void;
  onDone: () => void;
  onMessage: (m: string) => void;
}) {
  const { view: v, now, address } = props;
  const { setTrustline } = useWallet();
  const [sponsorNeeded, setSponsorNeeded] = useState(false);
  const [busy, setBusy] = useState(false);
  const isRecipient = v.role === "recipient";
  const ready = v.claimableNow && (isRecipient || !v.deadline || now >= v.deadline + CLOCK_MARGIN);

  const prepare = useCallback(async (): Promise<Prepared> => {
    const check = (e: Explanation) => {
      if (e.kind !== "claim") return ["transaction type"];
      const out: string[] = [];
      if (e.fields.balanceId !== v.id) out.push("balance");
      if (e.fields.claimant !== address) out.push("account");
      return out;
    };
    // Recipients claim for free: Nilo's sponsor pays the fee and any trustline reserve.
    // If the sponsor is unavailable, fall back to a claim the recipient pays for.
    if (isRecipient && config.sponsor) {
      try {
        return { xdr: await requestSponsoredClaim(v.id, address), check };
      } catch (e) {
        console.warn("Sponsored claim unavailable, falling back to self-paid:", (e as Error).message);
      }
    }
    const account = await loadAccount(address);
    if (!account) throw new Error("Your account does not exist on testnet yet. Fund it (e.g. Friendbot) and try again.");
    const needsTrust = !hasTrustline(asSnapshot(account), { code: v.asset.code, issuer: v.asset.issuer });
    if (needsTrust && !canAffordTrustline(asSnapshot(account))) {
      setSponsorNeeded(true);
      throw new Error(
        `To receive ${v.asset.code} your account needs a trustline, which reserves 0.5 XLM, and you don't have enough spare XLM. Enable ${v.asset.code} below (Pollar can sponsor it), then claim.`,
      );
    }
    const xdr = buildClaimTx(v.id, account, config, needsTrust ? { code: v.asset.code, issuer: v.asset.issuer } : undefined);
    return { xdr, check };
  }, [address, isRecipient, v.id, v.asset.code, v.asset.issuer]);

  return (
    <article className="card">
      <div className="card-head">
        <strong>
          {fromStroops(toStroops(v.amount))} {v.asset.code}
        </strong>
        <span className={`pill ${v.status}`}>{v.status}</span>
      </div>
      <p className="mono-wrap small">
        {isRecipient ? `From ${v.sender ?? "unknown"}` : `To ${v.recipient ?? "unknown"}`}
      </p>
      {v.deadline && (
        <p className="small">
          Deadline {formatLocal(v.deadline)} ({formatRelative(v.deadline - now)})
        </p>
      )}
      <p className="small">{STATUS_TEXT[v.status]}</p>
      {sponsorNeeded && v.asset.issuer && (
        <button
          className="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const out = await setTrustline({ code: v.asset.code, issuer: v.asset.issuer! });
            setBusy(false);
            if (out.status === "success" || out.status === "pending") {
              setSponsorNeeded(false);
              props.onMessage(`${v.asset.code} enabled. You can claim now.`);
              props.onClose();
            } else {
              props.onMessage(`Could not enable ${v.asset.code}: ${"message" in out ? out.message : out.status}`);
            }
          }}
        >
          {busy ? "Enabling…" : `Enable ${v.asset.code} via Pollar`}
        </button>
      )}
      {props.active ? (
        <SignPanel
          prepare={prepare}
          signLabel={isRecipient ? "Sign and claim" : "Sign and recover"}
          onCancel={props.onClose}
          onDone={props.onDone}
        />
      ) : (
        v.claimableNow && (
          <button disabled={!ready} onClick={props.onOpen}>
            {isRecipient ? "Claim" : ready ? "Recover" : "Recover (a few seconds…)"}
          </button>
        )
      )}
    </article>
  );
}

/** Explains (and on testnet fixes) a wallet that is not on the ledger yet. */
function AccountCheck(props: { address: string; funding: boolean; setFunding: (b: boolean) => void; onFunded: () => void }) {
  const [missing, setMissing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    loadAccount(props.address).then((a) => setMissing(!a), () => setMissing(false));
  }, [props.address]);
  if (!missing) return null;
  return (
    <div className="warning">
      Your account is not on the testnet ledger yet, so it can't claim. New Pollar wallets are created in the
      background; wait a few seconds, or fund it with Friendbot.{" "}
      <button
        className="link"
        disabled={props.funding}
        onClick={async () => {
          props.setFunding(true);
          setErr(null);
          try {
            await friendbot(props.address);
            setMissing(false);
            props.onFunded();
          } catch (e) {
            setErr((e as Error).message);
          } finally {
            props.setFunding(false);
          }
        }}
      >
        {props.funding ? "Funding…" : "Fund with Friendbot"}
      </button>
      {err && <span className="error"> {err}</span>}
    </div>
  );
}
