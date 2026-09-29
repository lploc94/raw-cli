export function Progress({ label, value, max, indeterminate }: { label?: string | undefined; value?: number | undefined; max?: number | undefined; indeterminate?: boolean | undefined }) {
  const total = max && max > 0 ? max : 100;
  const known = !indeterminate && typeof value === "number";
  return (
    <div className="panel-progress-block">
      {label && <span>{label}</span>}
      <progress aria-label={label ?? "Progress"} max={total} {...(known ? { value } : {})} />
      {known && <small>{value} / {total}</small>}
    </div>
  );
}
