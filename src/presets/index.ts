import { registerOntology } from '../core-graph/index.ts';
import { developmentGraph } from './development-graph/index.ts';
import type { Preset } from './types.ts';

export { DEVELOPMENT_GRAPH, developmentGraph } from './development-graph/index.ts';
export type { EntityTypeDef, Preset, RelationTypeDef } from './types.ts';

const presets: readonly Preset[] = Object.freeze([developmentGraph]);

/** Registers every preset's ontology in core-graph. Call once at startup; calling again is harmless. */
export function registerPresets(): void {
  for (const preset of presets) registerOntology(preset.id, preset.ontology);
}

export function listPresets(): readonly Preset[] {
  return presets;
}

export function getPreset(id: string): Preset | undefined {
  return presets.find((preset) => preset.id === id);
}
