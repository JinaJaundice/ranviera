import type { ButtonHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  icon: LucideIcon;
  /** the accessible name, also shown as the tooltip */
  label: string;
  active?: boolean;
  size?: number;
}

export function IconButton({ icon: Icon, label, active = false, size = 16, className = "", type = "button", ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent hover:bg-raised hover:text-ink disabled:opacity-50 ${
        active ? "bg-raised text-ink" : "text-ink-soft"
      } ${className}`}
      {...rest}
    >
      <Icon size={size} aria-hidden="true" />
    </button>
  );
}
