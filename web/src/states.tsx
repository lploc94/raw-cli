import { Component, useLayoutEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { errorText } from "./api.js";
import { Empty } from "./ui.js";

/*
 * Loading / empty / error vocabulary shared by every screen.
 *
 * Rules the rest of the dashboard follows:
 *  - Skeletons appear only on the first load of a key; background revalidation is silent.
 *  - Skeleton regions reserve the same box as the real content (no layout shift).
 *  - The reveal is delayed ~150ms in CSS (`.skeleton-region`) so fast responses never flash.
 */

type Shape = "line" | "block" | "circle";
export function Skeleton({
  shape = "line",
  width,
  className = "",
}: {
  shape?: Shape;
  /** Preset width class (`w-30`, `w-50`, `w-70`, `w-90`); CSP forbids inline styles. */
  width?: 30 | 40 | 50 | 60 | 70 | 80 | 90;
  className?: string;
}) {
  return (
    <span
      className={`skeleton skeleton-${shape}${width ? ` w-${width}` : ""} ${className}`}
      aria-hidden="true"
    />
  );
}

/** Wraps skeleton content: hidden from assistive tech but announces a single busy status. */
export function SkeletonRegion({
  label,
  className = "",
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`skeleton-region ${className}`} aria-busy="true">
      <span className="sr-only" role="status">
        {label}
      </span>
      {children}
    </div>
  );
}

export function SessionRowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <SkeletonRegion label="Loading sessions">
      {Array.from({ length: rows }, (_, index) => (
        <div className="session-row skeleton-row" key={index}>
          <Skeleton shape="circle" className="skeleton-dot" />
          <span>
            <Skeleton width={index % 2 ? 70 : 90} />
            <Skeleton width={40} className="skeleton-small" />
          </span>
        </div>
      ))}
    </SkeletonRegion>
  );
}

export function TimelineSkeleton() {
  return (
    <SkeletonRegion label="Loading conversation">
      {[90, 70, 80].map((width, index) => (
        <div className="skeleton-message" key={index}>
          <Skeleton width={30} className="skeleton-small" />
          <Skeleton width={width as 70 | 80 | 90} />
          <Skeleton width={60} />
        </div>
      ))}
    </SkeletonRegion>
  );
}

/** Generic settings/library body: a heading plus a few resource rows. */
export function PageSkeleton({ rows = 5, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <SkeletonRegion label={label} className="skeleton-page">
      <Skeleton width={30} className="skeleton-title" />
      <Skeleton width={50} className="skeleton-small" />
      {Array.from({ length: rows }, (_, index) => (
        <div className="skeleton-card" key={index}>
          <Skeleton width={index % 2 ? 40 : 60} />
          <Skeleton width={90} className="skeleton-small" />
        </div>
      ))}
    </SkeletonRegion>
  );
}

/** Whole-app placeholder while `/bootstrap` resolves; matches the shell so nothing jumps. */
export function ShellSkeleton() {
  return (
    <SkeletonRegion label="Opening your workspace" className="skeleton-shell">
      <PageSkeleton rows={4} label="Reading local configuration" />
    </SkeletonRegion>
  );
}

export function ErrorState({
  error,
  title = "Something went wrong",
  onRetry,
}: {
  error: unknown;
  title?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="error-state" role="alert">
      <strong>{title}</strong>
      <p className="muted">{errorText(error)}</p>
      {onRetry && (
        <button type="button" onClick={onRetry}>
          <RefreshCw size={15} aria-hidden="true" />
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * Keeps a skeleton on screen long enough to be read. The CSS reveal delay hides fast responses
 * (`delay`); once a skeleton has become visible it stays for at least `hold` more milliseconds,
 * so a response landing just after the reveal never produces a one-frame placeholder flash.
 */
export function useHeldLoading(loading: boolean, delay = 150, hold = 300): boolean {
  const [held, setHeld] = useState(loading);
  const since = useRef<number | undefined>(loading ? performance.now() : undefined);
  useLayoutEffect(() => {
    if (loading) {
      since.current ??= performance.now();
      setHeld(true);
      return;
    }
    if (since.current === undefined) {
      setHeld(false);
      return;
    }
    const elapsed = performance.now() - since.current;
    since.current = undefined;
    if (elapsed < delay) {
      setHeld(false);
      return;
    }
    const timer = setTimeout(() => setHeld(false), Math.max(0, delay + hold - elapsed));
    return () => clearTimeout(timer);
  }, [loading, delay, hold]);
  return loading || held;
}

/**
 * First-load gate for a page or panel. Returns the placeholder to render (skeleton, or an error
 * with Retry when there is nothing to show) while the data is not ready, and `null` once the
 * page can render. Cached data is `ready` immediately, so revisits never show a skeleton.
 */
export function usePageGate({
  ready,
  error,
  onRetry,
  label,
  rows,
  bare = false,
}: {
  ready: boolean;
  error: unknown;
  onRetry: () => void;
  label: string;
  rows?: number;
  /** Omit the `management-page` wrapper when the parent already provides it. */
  bare?: boolean;
}): ReactNode {
  const holding = useHeldLoading(!ready && !error);
  const wrap = (node: ReactNode) => (bare ? node : <div className="management-page">{node}</div>);
  if (holding)
    return wrap(<PageSkeleton label={label} {...(rows === undefined ? {} : { rows })} />);
  if (!ready) return wrap(<ErrorState error={error} title="Could not load this page" onRetry={onRetry} />);
  return null;
}

/** Route-level safety net: a render error in one page must not blank the whole shell. */
export class PageErrorBoundary extends Component<
  { children: ReactNode; resetKey?: string },
  { error: unknown }
> {
  override state = { error: undefined as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error: error ?? new Error("Unknown error") };
  }
  override componentDidUpdate(previous: { resetKey?: string }) {
    if (this.state.error !== undefined && previous.resetKey !== this.props.resetKey)
      this.setState({ error: undefined });
  }
  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }
  override render() {
    if (this.state.error === undefined) return this.props.children;
    return (
      <Empty title="This page failed to render">
        {errorText(this.state.error)}
      </Empty>
    );
  }
}
