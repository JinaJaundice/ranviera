import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  icon?: ReactNode;
}

const VARIANTS: Record<Variant, string> = {
  primary: "bg-signal text-on-signal border-signal hover:opacity-90",
  secondary: "bg-raised text-ink border-rule-strong hover:bg-sunken",
  ghost: "bg-transparent text-ink-soft border-transparent hover:bg-raised hover:text-ink",
};

export function Button({ variant = "secondary", icon, className = "", children, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-3 text-body font-medium disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}
