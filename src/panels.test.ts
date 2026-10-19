import { describe, it, expect } from 'vitest';
import { gridPanels, activatePanel, assignPanel } from './panels';
describe('grid panel selection', () => {
  it('fills open tabs, preserves order and never duplicates a terminal', () => {
    expect(gridPanels(['a','b','c','d','e'], ['c','a','c','deleted','b'], 'a')).toEqual(['c','a','b','d']);
    expect(gridPanels(['a','b','c'], [], 'c')).toEqual(['a','b','c']);
    expect(gridPanels([], ['deleted'], '')).toEqual([]);
  });
  it('focuses a visible panel without moving it or hiding another one', () => {
    const panes = ['c','a','b','d'];
    expect(activatePanel(panes, 'a', 'd')).toBe(panes);
  });
  it('replaces only the focused slot for a hidden/new tab and fills empty slots first', () => {
    expect(activatePanel(['c','a','b','d'], 'b', 'e')).toEqual(['c','a','e','d']);
    expect(activatePanel(['c','a','b'], 'b', 'e')).toEqual(['c','a','b','e']);
    expect(gridPanels(['a','b','c','d','e'], ['a','b','c','d'], 'e')).toEqual(['e','b','c','d']);
  });
  it('swaps an already displayed tab and replaces a hidden one', () => {
    expect(assignPanel(['a','b','c','d'], 1, 'd')).toEqual(['a','d','c','b']);
    expect(assignPanel(['a','b','c','d'], 1, 'e')).toEqual(['a','e','c','d']);
  });
  it('removes closed tabs and fills with surviving hidden tabs', () => {
    expect(gridPanels(['a','c','d','e'], ['a','b','c','d'], 'c')).toEqual(['a','c','d','e']);
  });
});
