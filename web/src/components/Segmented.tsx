interface SegmentedProps<T extends string> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}

export function Segmented<T extends string>({ options, value, onChange, label }: SegmentedProps<T>) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-rule-strong bg-sunken p-0.5">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={`h-7 rounded-sm px-3 text-small font-medium ${on ? "bg-raised text-ink" : "text-ink-soft hover:text-ink"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
