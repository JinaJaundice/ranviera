// A small graph snapshot for the tests of the Knowledge layer.
import type { GraphSnapshot, PropositionView } from "@shared/learn/knowledge";

const prop = (id: string, name: string, statement: string, src: string, aliases: string[] = []): PropositionView => ({
  id,
  name,
  statement,
  aliases,
  createdAt: "2026-10-01T10:00:00.000Z",
  provenance: [{ chatId: src, messageId: "" }],
  sensitivity: "internal",
  metrics: { support: 1, held: "unknown", lastTested: null, calibration: null },
});

export function makeSnapshot(): GraphSnapshot {
  const propositions = [
    prop("n_a1", "Heat flow", "Heat flows from hot to cold.", "src_ent", ["Heat moves downhill"]),
    prop("n_a2", "Heat engines", "Heat engines turn a heat flow into work.", "src_ent", ["Engines convert heat to work"]),
    prop("n_a3", "Entropy", "Entropy measures how spread out energy is.", "src_ent"),
    prop("n_a4", "Entropy rise", "A closed system tends towards more entropy.", "src_ent"),
    prop("n_b1", "Second law", "The second law limits how much heat can become work.", "src_th"),
    prop("n_b2", "Engine limit", "No engine is perfectly efficient.", "src_th"),
    prop("n_c1", "Equilibrium", "A system at equilibrium has no net flow of heat.", "chat_1"),
  ];
  return {
    nodes: [
      ...propositions.map((p) => ({ id: p.id, name: p.name, statement: p.statement, kind: "proposition" as const })),
      { id: "arg_1", name: "⇒", statement: "Entropy rise, Heat flow imply Engine limit", kind: "junction" },
    ],
    propositions,
    edges: [
      { from: "n_a3", to: "n_a4" },
      { from: "n_a4", to: "arg_1" },
      { from: "n_a1", to: "arg_1" },
      { from: "arg_1", to: "n_b2" },
    ],
    logicalEdges: [],
    impLinks: [{ id: "arg_1", premises: ["n_a4", "n_a1"], conclusion: "n_b2" }],
    chains: [
      { id: "arg_0", premises: ["n_a3"], conclusion: "n_a4", createdAt: "2026-10-05T10:00:00.000Z", provenance: [{ chatId: "src_ent", messageId: "" }], sensitivity: "internal" },
      { id: "arg_1", premises: ["n_a4", "n_a1"], conclusion: "n_b2", createdAt: "2026-10-06T10:00:00.000Z", provenance: [{ chatId: "src_th", messageId: "" }], sensitivity: "internal" },
      { id: "arg_2", premises: ["n_b1"], conclusion: "n_b2", createdAt: "2026-10-04T10:00:00.000Z", provenance: [{ chatId: "src_th", messageId: "" }], sensitivity: "internal" },
    ],
    sessions: { chat_1: "Thermodynamics lecture" },
    fileSources: { src_ent: "Notes/entropy.md", src_th: "Notes/thermodynamics.md" },
    nodeSessions: {},
    clusters: [
      { id: "src_ent", label: null, members: ["n_a1", "n_a2", "n_a3", "n_a4"] },
      { id: "src_th", label: null, members: ["n_b1", "n_b2", "arg_1"] },
    ],
    positions: {
      n_a1: { x: 0, y: 0 },
      n_a2: { x: 40, y: 0 },
      n_a3: { x: 0, y: 40 },
      n_a4: { x: 40, y: 40 },
      n_b1: { x: 200, y: 0 },
      n_b2: { x: 240, y: 40 },
      n_c1: { x: 100, y: 200 },
    },
    revision: 7,
  };
}
