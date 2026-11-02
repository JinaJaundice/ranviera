// The render settings of routes 35 and 36. Each size is a slider over an eleven stop ladder with the default in the middle, so
// that every position gives a clean number. A change is saved by the layer after a short pause.
import type { RenderSettings } from "@shared/learn/knowledge";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { X } from "lucide-react";
import { LADDERS, defaultSettings, gateWords, positionOf, valueAt, withLadder, withRegion, type LadderKey } from "./settings";

function Slider({ label, hint, ladder, value, onChange, words, disabled }: { label: string; hint?: string; ladder: readonly number[]; value: number; onChange: (position: number) => void; words?: (v: number) => string; disabled?: boolean }) {
  const pos = positionOf(value, ladder);
  const shown = valueAt(pos, ladder);
  return (
    <label className={`block min-w-0 ${disabled ? "opacity-50" : ""}`}>
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-small text-ink-soft">{label}</span>
        <span className="num text-small text-ink">{words ? words(shown) : shown}</span>
      </span>
      <input type="range" min={0} max={100} step={10} value={pos} disabled={disabled} aria-valuetext={words ? words(shown) : String(shown)} onChange={(e) => onChange(Number(e.target.value))} className="mt-1 h-4 w-full accent-signal" />
      {hint ? <span className="block text-caption text-ink-faint">{hint}</span> : null}
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-body text-ink">
      <input type="checkbox" className="accent-signal" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function SettingsPanel({ settings: s, onChange, onClose, error }: { settings: RenderSettings; onChange: (next: RenderSettings) => void; onClose: () => void; error: string | null }) {
  const ladder = (key: LadderKey, label: string, hint?: string, words?: (v: number) => string) => (
    <Slider label={label} hint={hint} ladder={LADDERS[key]} value={s[key]} onChange={(p) => onChange(withLadder(s, key, p))} words={words} disabled={key === "clusterLabelSize" && !s.clusterLabels} />
  );
  return (
    <div role="dialog" aria-label="Render settings" className="absolute right-2 top-10 z-20 flex max-h-[min(60%,32rem)] w-72 max-w-[calc(100%-16px)] min-w-0 flex-col rounded-lg border border-rule-strong bg-overlay">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-rule pl-3 pr-1">
        <h3 className="text-ui font-medium text-ink">Render settings</h3>
        <IconButton icon={X} label="Close the settings" onClick={onClose} className="h-6 w-6" size={14} />
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {ladder("nodeSize", "Claim size")}
        {ladder("edgeWidth", "Line width")}
        {ladder("arrowLength", "Arrowhead size")}
        {ladder("labelSize", "Label size")}
        {ladder("labelZoom", "Show labels until", "A larger number shows claim labels from further out.", gateWords)}
        <Toggle label="Name each source on the map" checked={s.clusterLabels} onChange={(v) => onChange({ ...s, clusterLabels: v })} />
        {ladder("clusterLabelSize", "Source name size")}
        <Toggle label="Tint the area of each source" checked={s.regions.enabled} onChange={(v) => onChange(withRegion(s, { enabled: v }))} />
        <Slider label="Tint spread" ladder={LADDERS.dilation} value={s.regions.dilation} disabled={!s.regions.enabled} onChange={(p) => onChange(withRegion(s, { dilation: valueAt(p, LADDERS.dilation) }))} />
        <Slider label="Tint strength" ladder={LADDERS.edgeAlpha} value={s.regions.edgeAlpha} disabled={!s.regions.enabled} onChange={(p) => onChange(withRegion(s, { edgeAlpha: valueAt(p, LADDERS.edgeAlpha) }))} />
        <p className="text-caption text-ink-faint">These settings are saved on this computer and are shared by every window that shows the graph.</p>
        {error ? (
          <p role="alert" className="break-words text-small text-block">
            {error}
          </p>
        ) : null}
        <Button variant="secondary" onClick={() => onChange(defaultSettings())}>
          Reset to the defaults
        </Button>
      </div>
    </div>
  );
}
