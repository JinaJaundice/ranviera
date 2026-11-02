// The switch between the structure of the set-up and the knowledge of the learning upgrade. It edits GraphView.layer.
import { Segmented } from "../../components/Segmented";
import { setGraphView, useStore } from "../../lib/store";

export function LayerSwitch() {
  const layer = useStore((s) => s.graphView.layer);
  return (
    <div>
      <p className="mb-1 text-small text-ink-soft">Layer</p>
      <Segmented
        label="Layer"
        value={layer}
        onChange={(l) => setGraphView({ layer: l })}
        options={[
          { value: "harness", label: "Structure" },
          { value: "knowledge", label: "Knowledge" },
        ]}
      />
    </div>
  );
}
