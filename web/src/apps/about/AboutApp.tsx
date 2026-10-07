import { useEffect } from "react";
import { Section } from "../../components/Section";
import { useStore } from "../../lib/store";
import { BRAIN_CHANGES, BRAIN_CITATION, PRIVACY_SUMMARY, copyrightLine, nonAffiliation, useProductName } from "../setup/copy";
import { refreshSetup, useSetupStore } from "../setup/state";

const COMPONENTS: { name: string; licence: string; use: string }[] = [
  { name: "React", licence: "MIT", use: "the windows" },
  { name: "three and 3d-force-graph", licence: "MIT", use: "the graph and brain drawing" },
  { name: "Lucide", licence: "ISC", use: "the icons" },
  { name: "Oxigraph", licence: "Apache 2.0 or MIT", use: "the SPARQL store" },
  { name: "Fuse.js", licence: "Apache 2.0", use: "the search" },
  { name: "rdflib", licence: "BSD 3-Clause", use: "the compiler" },
  { name: "pySHACL", licence: "Apache 2.0", use: "the shape checks" },
  { name: "Nemo", licence: "Apache 2.0 or MIT", use: "the reasoning rules" },
  { name: "Electron", licence: "MIT", use: "the desktop shell" },
];

const FONTS: { name: string; licence: string }[] = [
  { name: "Inter", licence: "SIL Open Font License 1.1" },
  { name: "Space Grotesk", licence: "SIL Open Font License 1.1" },
  { name: "JetBrains Mono", licence: "SIL Open Font License 1.1" },
];

export function AboutApp() {
  const status = useStore((s) => s.status);
  const setup = useSetupStore((s) => s.setup);
  useEffect(() => {
    void refreshSetup();
  }, []);
  const name = useProductName();
  const version = status?.version ?? setup?.version;

  return (
    <div className="h-full min-w-0 overflow-y-auto">
      <div className="border-b border-rule px-4 py-4">
        <h3 className="font-display text-title font-medium text-ink">{name}</h3>
        <p className="num mt-0.5 text-body text-ink-soft">{version ? `Version ${version}` : "Version not reported"}</p>
        <p className="mt-2 text-body text-ink-soft">Draws your Claude Code set-up as a graph and a brain, and replays what Claude Code does as it works.</p>
      </div>
      <Section title="Licence">
        <p className="text-body text-ink-soft">
          The product is released under the Apache License 2.0. {copyrightLine(name)} The software is provided as it is, with no warranty beyond the licence. The full text is in the LICENSE file and the notices are in the NOTICE and THIRD_PARTY_NOTICES.md files.
        </p>
      </Section>
      <Section title="Independence from Anthropic">
        <p className="text-body text-ink-soft">{nonAffiliation(name)}</p>
      </Section>
      <Section title="Privacy">
        <p className="text-body text-ink-soft">{PRIVACY_SUMMARY}</p>
      </Section>
      <Section title="Brain model">
        <p className="text-body text-ink-soft">{BRAIN_CITATION}</p>
        <p className="mt-2 text-body text-ink-soft">{BRAIN_CHANGES}</p>
      </Section>
      <Section title="Typefaces">
        <ul className="min-w-0 divide-y divide-rule rounded-md border border-rule text-body">
          {FONTS.map((f) => (
            <li key={f.name} className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 px-3 py-1.5">
              <span className="min-w-0 text-ink">{f.name}</span>
              <span className="min-w-0 text-ink-soft">{f.licence}</span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Open-source components" note="The full list with every licence is in THIRD_PARTY_NOTICES.md.">
        <ul className="min-w-0 divide-y divide-rule rounded-md border border-rule text-body">
          {COMPONENTS.map((c) => (
            <li key={c.name} className="grid min-w-0 grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)] gap-3 px-3 py-1.5">
              <span className="min-w-0 text-ink">{c.name}</span>
              <span className="min-w-0 text-ink-soft">{c.licence}</span>
              <span className="min-w-0 text-ink-soft">{c.use}</span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
