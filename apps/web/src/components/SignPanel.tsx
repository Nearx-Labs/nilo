import { explain, type Explanation } from "@stellar-dots/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { config, explorerTx } from "../stellar";
import { UserCancelled, isSubmitFailure, useWallet } from "../wallet";
import { ExplainCard } from "./ExplainCard";

export interface Prepared {
  xdr: string;
  /** Names of fields where the decoded transaction disagrees with what was requested. */
  check: (e: Explanation) => string[];
}

type State =
  | { step: "building"; notice?: string }
  | { step: "review"; xdr: string; explanation: Explanation; problems: string[]; notice?: string }
  | { step: "signing"; xdr: string; explanation: Explanation; problems: string[] }
  | { step: "done"; hash: string }
  | { step: "error"; message: string };

interface Props {
  /** Builds (or rebuilds) the transaction from fresh account state. Throws with a user-facing message. */
  prepare: () => Promise<Prepared>;
  signLabel: string;
  onCancel: () => void;
  onDone: (hash: string) => void;
  doneMessage?: React.ReactNode;
}

export function SignPanel({ prepare, signLabel, onCancel, onDone, doneMessage }: Props) {
  const { signAndSubmit } = useWallet();
  const [state, setState] = useState<State>({ step: "building" });
  // Build once per panel, on mount. Callers may pass a new `prepare` on every
  // render (lists re-render each second for countdowns); rebuilding on each one
  // would reset the panel mid-signature.
  const prepareRef = useRef(prepare);
  prepareRef.current = prepare;

  const build = useCallback(
    async (notice?: string) => {
      setState({ step: "building", notice });
      try {
        const p = await prepareRef.current();
        const explanation = explain(p.xdr, config);
        setState({ step: "review", xdr: p.xdr, explanation, problems: p.check(explanation), notice });
      } catch (e) {
        setState({ step: "error", message: (e as Error).message });
      }
    },
    [],
  );

  useEffect(() => {
    build();
  }, [build]);

  async function sign() {
    if (state.step !== "review") return;
    const { xdr, explanation, problems } = state;
    setState({ step: "signing", xdr, explanation, problems });
    try {
      // Pollar signs with the logged-in wallet (extension, or the embedded wallet) and submits.
      const hash = await signAndSubmit(xdr);
      setState({ step: "done", hash });
      onDone(hash);
    } catch (e) {
      if (e instanceof UserCancelled) {
        onCancel();
      } else if (isSubmitFailure(e) && e.retryable) {
        await build(`${e.message} The transaction was rebuilt. Review it and sign again.`);
      } else {
        setState({ step: "error", message: isSubmitFailure(e) ? e.message : (e as Error).message });
      }
    }
  }

  if (state.step === "building") return <p className="muted">{state.notice ?? "Building transaction…"}</p>;
  if (state.step === "error")
    return (
      <div className="panel">
        <p className="error">{state.message}</p>
        <div className="row">
          <button onClick={() => build()}>Try again</button>
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  if (state.step === "done")
    return (
      <div className="panel success">
        <p>
          Submitted.{" "}
          <a href={explorerTx(state.hash)} target="_blank" rel="noreferrer">
            View transaction
          </a>
        </p>
        {doneMessage}
      </div>
    );

  const blocked = state.explanation.kind === "unrecognized" || state.problems.length > 0;
  const busy = state.step !== "review";
  return (
    <div className="panel">
      {state.step === "review" && state.notice && <p className="warning">{state.notice}</p>}
      <ExplainCard explanation={state.explanation} problems={state.problems} />
      <div className="row">
        <button disabled={blocked || busy} onClick={sign}>
          {state.step === "signing" ? "Waiting for your wallet…" : signLabel}
        </button>
        <button className="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
