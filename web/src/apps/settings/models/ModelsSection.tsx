// The sections Provider keys, Claude Code, Custom endpoint and Models for the Settings
// window. SettingsApp.tsx mounts <ModelsSection /> once, as a merge edit. Behaviour is
// specified in docs/CONTRACTS.md ("Routes") and the layout in the Cortex design kit.
import { useEffect } from "react";
import { Section } from "../../../components/Section";
import { setupGap } from "../../../lib/learn/models";
import { ClaudeCodePanel } from "./ClaudeCodePanel";
import { CustomEndpoint } from "./CustomEndpoint";
import { KeysPanel } from "./KeysPanel";
import { Loading, Notice } from "./parts";
import { SlotPickers } from "./SlotPickers";
import { loadModels, useModelsStore } from "./state";

export function ModelsSection() {
  const catalog = useModelsStore((s) => s.catalog);
  const error = useModelsStore((s) => s.error);
  useEffect(() => {
    void loadModels();
  }, []);
  const gap = catalog ? setupGap(catalog) : null;
  const gapNote = gap === "keys" ? "Add a provider key or switch on Claude Code to list models." : gap === "models" ? "Choose a model for each of the three slots before you start a lesson or read sources." : undefined;

  return (
    <>
      <Section title="Provider keys" note="A key stays on this computer in the keys file and is shown as its last four characters. An environment variable of the same name wins over a saved key.">
        {catalog ? <KeysPanel /> : error ? null : <Loading what="keys" />}
        <Notice text={error} tone="error" />
      </Section>
      <Section title="Claude Code" note="Claude Code can serve as a model for lessons. It is off until you switch it on.">
        {catalog ? <ClaudeCodePanel /> : error ? null : <Loading what="Claude Code status" />}
      </Section>
      <Section title="Custom endpoint" note="Any server that speaks the OpenAI chat completions interface, hosted or on your own machine, with or without a key.">
        {catalog ? <CustomEndpoint /> : error ? null : <Loading what="the endpoint" />}
      </Section>
      <Section title="Models" note={gapNote}>
        {catalog ? <SlotPickers /> : error ? null : <Loading what="models" />}
      </Section>
    </>
  );
}
