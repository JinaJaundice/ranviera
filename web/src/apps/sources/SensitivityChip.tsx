// The sensitivity of a root or a claim as an icon and a word. The chip is neutral in all three cases, because colour is kept for status.
import { Building2, Globe, Lock } from "lucide-react";
import type { Sensitivity } from "@shared/types";
import { SENSITIVITY_LABELS } from "../../lib/learn/sources";

const ICON = { public: Globe, internal: Building2, "client-confidential": Lock } as const;

export function SensitivityChip({ value }: { value: Sensitivity }) {
  const Icon = ICON[value];
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-rule px-1.5 py-0.5 text-caption text-ink-soft">
      <Icon size={12} aria-hidden="true" />
      {SENSITIVITY_LABELS[value]}
    </span>
  );
}
