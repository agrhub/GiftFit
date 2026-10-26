"use client";
/**
 * The frame's side of the widget postMessage protocol (owner: A6; protocol in lib/widget/protocol.ts).
 * Posts only to `parentOrigin` and accepts only messages from window.parent on that origin. With no
 * parent (the page opened directly), every call is a no-op.
 */
import { useCallback, useEffect, useRef } from "react";
import { acceptHostMessage, frameMessage, type FrameMessage, type HostMessage } from "@/lib/widget/protocol";

export function useHostBridge(parentOrigin: string | null, onMessage: (msg: HostMessage) => void) {
  const handler = useRef(onMessage);
  useEffect(() => {
    handler.current = onMessage;
  }, [onMessage]);

  const framed = typeof window !== "undefined" && window.parent !== window;

  const post = useCallback(
    (msg: FrameMessage) => {
      if (!parentOrigin || typeof window === "undefined" || window.parent === window) return;
      window.parent.postMessage(frameMessage(msg), parentOrigin);
    },
    [parentOrigin],
  );

  useEffect(() => {
    if (!parentOrigin) return;
    const listener = (e: MessageEvent) => {
      const msg = acceptHostMessage(e, parentOrigin, window.parent);
      if (msg) handler.current(msg);
    };
    window.addEventListener("message", listener);
    post({ type: "ready" });
    return () => window.removeEventListener("message", listener);
  }, [parentOrigin, post]);

  return { post, framed };
}
