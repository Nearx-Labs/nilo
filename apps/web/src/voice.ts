// Voice mode: the browser side of a GPT-Live session. The server creates the session (it holds
// the key) and answers our WebRTC offer; audio flows on media tracks and JSON events on the
// "oai-events" data channel. The backend model asks for tools; the page runs them and the
// result goes back to be spoken.
import { useEffect, useRef, useState } from "react";

export type VoiceState = "idle" | "connecting" | "live" | "closing";

export interface VoiceHandlers {
  /** Runs a tool the backend asked for; the returned text goes back to the conversation. */
  onToolCall: (name: string, args: unknown) => Promise<string>;
  /** A finished turn of speech, for the chat log. */
  onTranscript: (role: "user" | "assistant", text: string) => void;
  onError: (message: string) => void;
}

/** Hang up on our own after this long: an open session is billed by the second. */
const MAX_SESSION_MS = 5 * 60_000;
const ICE_TIMEOUT_MS = 10_000;
/** How long to wait for session.closed (final usage) before tearing down anyway. */
const CLOSE_TIMEOUT_MS = 15_000;

export function useVoiceSession(handlers: VoiceHandlers) {
  const [state, setState] = useState<VoiceState>("idle");
  const h = useRef(handlers);
  h.current = handlers;
  const teardown = useRef<(() => void) | null>(null);
  const hangup = useRef<(() => void) | null>(null);

  useEffect(() => () => teardown.current?.(), []);

  async function start() {
    if (state !== "idle") return;
    setState("connecting");
    const pc = new RTCPeerConnection();
    const audio = new Audio();
    audio.autoplay = true;
    let mic: MediaStream | null = null;
    const timers: number[] = [];
    let done = false;

    const cleanup = () => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      mic?.getTracks().forEach((t) => t.stop());
      pc.close();
      audio.srcObject = null;
      teardown.current = hangup.current = null;
      setState("idle");
    };
    teardown.current = cleanup;

    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      mic.getTracks().forEach((t) => pc.addTrack(t, mic!));
      pc.ontrack = (e) => {
        audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
        audio.play().catch(() => {});
      };
      // The channel has to exist before the offer so it is negotiated with it.
      const dc = pc.createDataChannel("oai-events");
      const send = (event: object) => {
        if (dc.readyState !== "open") return false;
        dc.send(JSON.stringify(event));
        return true;
      };
      hangup.current = () => {
        setState("closing");
        if (!send({ type: "session.close" })) return cleanup();
        timers.push(window.setTimeout(cleanup, CLOSE_TIMEOUT_MS));
      };
      listen(dc, send, cleanup);

      await pc.setLocalDescription(await pc.createOffer());
      await iceGathered(pc);
      if (done) return;
      const res = await fetch("/api/voice/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sdp: pc.localDescription!.sdp }),
      });
      const body = (await res.json().catch(() => ({}))) as { sdp?: string; message?: string };
      if (!res.ok || !body.sdp) throw new Error(body.message ?? "Voice mode is unavailable right now.");
      if (done) return;
      await pc.setRemoteDescription({ type: "answer", sdp: body.sdp });
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") cleanup();
      };
      timers.push(window.setTimeout(() => hangup.current?.(), MAX_SESSION_MS));
    } catch (e) {
      const err = e as Error;
      h.current.onError(
        err.name === "NotAllowedError" ? "Voice mode needs the microphone. Allow it in your browser and try again." : err.message,
      );
      cleanup();
    }
  }

  function listen(dc: RTCDataChannel, send: (e: object) => boolean, cleanup: () => void) {
    // Speech arrives as transcript fragments; a turn ends when the other side starts speaking.
    let turn: { role: "user" | "assistant"; text: string } | null = null;
    const flush = () => {
      if (turn?.text.trim()) h.current.onTranscript(turn.role, turn.text.trim());
      turn = null;
    };
    const hear = (role: "user" | "assistant", delta: string) => {
      if (turn?.role !== role) flush();
      turn ??= { role, text: "" };
      turn.text += delta;
    };

    dc.onmessage = async (msg) => {
      let event: { type?: string; [k: string]: unknown };
      try {
        event = JSON.parse(msg.data);
      } catch {
        return;
      }
      switch (event.type) {
        case "session.started":
          setState("live");
          break;
        case "session.input_transcript.delta":
          hear("user", String(event.delta ?? ""));
          break;
        case "session.output_transcript.delta":
          hear("assistant", String(event.delta ?? ""));
          break;
        case "response.event": {
          const inner = event.event as { type?: string; item?: { type?: string; call_id?: string; name?: string; arguments?: string } };
          if (inner?.type !== "response.output_item.done" || inner.item?.type !== "function_call") break;
          flush();
          const { call_id, name = "", arguments: raw = "{}" } = inner.item;
          let output: string;
          try {
            output = await h.current.onToolCall(name, JSON.parse(raw));
          } catch (e) {
            output = `Error: ${(e as Error).message}`;
          }
          send({ type: "response.item.create", item: { type: "function_call_output", call_id, output } });
          send({ type: "response.create" });
          break;
        }
        case "error": {
          const error = event.error as { code?: string; message?: string } | undefined;
          console.warn("voice session error:", error);
          break;
        }
        case "session.closed":
          flush();
          console.info("voice session closed:", event.reason, event.usage);
          if (event.reason === "expired") h.current.onError("The voice session reached its time limit.");
          cleanup();
          break;
      }
    };
    dc.onclose = () => {
      flush();
      cleanup();
    };
  }

  return {
    state,
    start,
    stop: () => (hangup.current ?? teardown.current)?.(),
  };
}

function iceGathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ICE_TIMEOUT_MS);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState !== "complete") return;
      clearTimeout(timer);
      resolve();
    });
  });
}
