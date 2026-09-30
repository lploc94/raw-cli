/** Circular progress toward the level the footer text reports: the auto-compact trigger when set, else the context window. */
export function ContextRing({ percent }: { percent: number | undefined }) {
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const known = percent !== undefined && Number.isFinite(percent);
  const used = known ? Math.min(100, Math.max(0, percent)) : 0;
  return (
    <span className="context-ring">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle className="ring-track" cx="8" cy="8" r={radius} />
        {known && (
          <circle
            className={`ring-fill ${used >= 90 ? "high" : ""}`}
            cx="8"
            cy="8"
            r={radius}
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - used / 100)}
            transform="rotate(-90 8 8)"
          />
        )}
      </svg>
      {known && <span aria-hidden="true">{Math.round(used)}%</span>}
    </span>
  );
}
