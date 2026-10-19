export const MAX_PANELS = 4;
export function gridPanels(tabIds: string[], preferred: string[], active: string): string[] {
  const valid = new Set(tabIds), panels = [...new Set(preferred)].filter(id => valid.has(id)).slice(0, MAX_PANELS);
  for (const id of tabIds) { if (panels.length >= MAX_PANELS) break; if (!panels.includes(id)) panels.push(id); }
  if (valid.has(active) && !panels.includes(active)) panels[0] = active;
  return panels;
}
export function activatePanel(panels: string[], previousActive: string, nextActive: string): string[] {
  if (panels.includes(nextActive)) return panels;
  const next = [...panels];
  if (next.length < MAX_PANELS) next.push(nextActive);
  else next[Math.max(0, next.indexOf(previousActive))] = nextActive;
  return next;
}
export function assignPanel(panels: string[], index: number, tabId: string): string[] {
  const next = [...panels], other = next.indexOf(tabId);
  if (other >= 0) [next[index], next[other]] = [next[other], next[index]];
  else next[index] = tabId;
  return next;
}
