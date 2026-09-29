import { useLayoutEffect, type RefObject } from "react";

function fit(element: HTMLTextAreaElement, maxRows: number) {
  element.style.height = "auto";
  const style = getComputedStyle(element);
  const line = parseFloat(style.lineHeight) || 20;
  const chrome = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const max = line * maxRows + chrome;
  element.style.height = `${Math.min(element.scrollHeight, max)}px`;
  element.style.overflowY = element.scrollHeight > max ? "auto" : "hidden";
}

/** Grows the textarea with its content up to `maxRows`, then lets it scroll; refits when its width changes. */
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxRows = 8,
) {
  useLayoutEffect(() => {
    if (ref.current) fit(ref.current, maxRows);
  }, [ref, value, maxRows]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      fit(element, maxRows);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, maxRows]);
}
