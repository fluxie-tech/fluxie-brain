import { describe, expect, it } from 'vitest';
import * as presets from '../../src/presets/index.ts';

describe('presets public API', () => {
  it('exports exactly what the spec defines', () => {
    expect(Object.keys(presets).sort()).toEqual(
      ['DEVELOPMENT_GRAPH', 'developmentGraph', 'getPreset', 'listPresets', 'registerPresets'].sort(),
    );
  });

  it('lists the Development Graph and finds it by id', () => {
    expect(presets.listPresets()).toContain(presets.developmentGraph);
    expect(presets.getPreset('development-graph')).toBe(presets.developmentGraph);
  });

  it('returns undefined for an unknown preset id', () => {
    expect(presets.getPreset('company-brain')).toBeUndefined();
  });
});
