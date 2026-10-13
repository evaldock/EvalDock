'use strict';

/**
 * Deterministic presentation only: no graph entities or relations are created.
 * Node coordinates are centres; returned group boxes use top-left x/y.
 * Annotated stages are reading groups, never task scopes or inferred causality.
 */
function layoutLargeTAG(visible, displayEdges, presentation = {}) {
  if (!visible.length) return {groups: [], bounds: {x: 0, y: 0, w: 100, h: 100}};
  const byId = new Map(visible.map(n => [n.id, n]));
  const number = n => Number.isFinite(n.index) ? n.index : Number.isFinite(n.recordIndex) ? n.recordIndex : null;
  const ordinal = n => number(n) ?? Number.MAX_SAFE_INTEGER;
  const compare = (a, b) => ordinal(a) - ordinal(b) || String(a.id).localeCompare(String(b.id), 'en');
  const ordered = [...visible].sort(compare);
  const sequence = new Set(['CAPTURE_NEXT', 'NEXT_RECORDED', 'CONTAINS']);
  const links = displayEdges.filter(e => !sequence.has(e.type))
    .map(e => ({a: byId.get(e.a ?? e.source), b: byId.get(e.b ?? e.target), type: e.type}))
    .filter(e => e.a && e.b && e.a !== e.b);
  let stages = (presentation.stages || []).filter(s => Number.isFinite(s.from) && Number.isFinite(s.to))
    .map((s, i) => ({id: s.id ?? 'reading-' + i, title: s.title || '记录分组 ' + (i + 1), from: s.from, to: s.to, recordIds:s.recordIds, reason:s.reason}));
  if (!stages.length) {
    const max = Math.max(1, presentation.recordCount || 0, ...ordered.map(n => number(n) || 0));
    const slice = Math.max(25, Math.ceil(max / 7));
    for (let from = 1; from <= max; from += slice) stages.push({
      id: 'records-' + from, title: '记录 ' + from + '–' + Math.min(max, from + slice - 1),
      from, to: Math.min(max, from + slice - 1)
    });
  }
  const groupOf = new Map();
  const stageFor = i => {
    const explicit=stages.findIndex(s=>s.recordIds?.includes("e"+i));if(explicit>=0)return explicit;
    const exact = stages.findIndex(s => i >= s.from && i <= s.to);
    if (exact >= 0) return exact;
    return stages.reduce((best, s, k) => Math.min(Math.abs(i - s.from), Math.abs(i - s.to)) <
      Math.min(Math.abs(i - stages[best].from), Math.abs(i - stages[best].to)) ? k : best, 0);
  };
  for (const n of ordered) if (number(n) !== null && n.kind !== 'resource' && n.kind !== 'state') groupOf.set(n.id, stageFor(number(n)));
  // Count relations, not filenames: a resource belongs to the reading group
  // with most incident recorded events. Ties resolve to the earlier group.
  for (const resource of ordered.filter(n => n.kind === 'resource')) {
    const votes = new Map();
    for (const e of links) {
      const other = e.a.id === resource.id ? e.b : e.b.id === resource.id ? e.a : null;
      if (!other) continue;
      let group = groupOf.get(other.id);
      if (group === undefined && number(other) !== null) group = stageFor(number(other));
      if (group !== undefined) votes.set(group, (votes.get(group) || 0) + 1);
      if (other.kind === 'state') for (const stateEdge of links) {
        const source = stateEdge.a.id === other.id ? stateEdge.b : stateEdge.b.id === other.id ? stateEdge.a : null;
        const stateGroup = source && groupOf.get(source.id);
        if (stateGroup !== undefined) votes.set(stateGroup, (votes.get(stateGroup) || 0) + 1);
      }
    }
    groupOf.set(resource.id, [...votes].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? stages.length - 1);
  }
  for (const n of ordered.filter(n => n.kind === 'state')) {
    const resourceId = n.resourceId || links.find(e => ['STATE_OF', 'VERSION_OF'].includes(e.type) && e.a.id === n.id)?.b.id;
    groupOf.set(n.id, groupOf.get(resourceId) ?? (number(n) !== null ? stageFor(number(n)) : stages.length - 1));
  }
  for (const n of ordered) if (!groupOf.has(n.id)) groupOf.set(n.id, n.kind === 'scope' ? 0 : stages.length - 1);

  const gap = 76, outer = 55, titleSpace = 78;
  const groups = stages.map((s, i) => ({...s, members: ordered.filter(n => groupOf.get(n.id) === i)}))
    .filter(s => s.members.length);
  function separate(local, passes) {
    let residual = 0;
    for (let pass = 0; pass < passes; pass++) {
      residual = 0;
      for (let i = 0; i < local.length; i++) for (let j = i + 1; j < local.length; j++) {
        const a = local[i], b = local[j], dx = b.x - a.x, dy = b.y - a.y;
        const ox = (a.w + b.w) / 2 + gap - Math.abs(dx), oy = (a.h + b.h) / 2 + gap - Math.abs(dy);
        if (ox > .005 && oy > .005) {
          residual++;
          if (ox < oy) {const p = (Math.sign(dx) || 1) * (ox + .02) / 2; a.x -= p; b.x += p;}
          else {const p = (Math.sign(dy) || 1) * (oy + .02) / 2; a.y -= p; b.y += p;}
        }
      }
      if (!residual) break;
    }
    return residual;
  }
  for (const group of groups) {
    const local = group.members, ids = new Set(local.map(n => n.id));
    const localLinks = links.filter(e => ids.has(e.a.id) && ids.has(e.b.id));
    const events = local.filter(n => n.kind === 'event'), eventRank = new Map(events.map((n, i) => [n.id, i]));
    const span = Math.sqrt(local.length) * 390, anchors = new Map();
    local.forEach((n, i) => {
      const angle = i * 2.399963229728653, radius = Math.sqrt((i + .5) / local.length) * span * .47;
      const rank = eventRank.get(n.id), orderX = rank === undefined ? 0 : (rank / Math.max(1, events.length - 1) - .5) * span;
      // A modest chronological gradient leaves space for objects and returns
      // to form neighbourhoods without imposing rows or a serpentine chain.
      n.x = Math.cos(angle) * radius * .8 + orderX * .55;
      n.y = Math.sin(angle) * radius * .8;
      n.groupId = group.id;
      anchors.set(n.id, {x: n.x, y: n.y});
    });
    for (let step = 0; step < 300; step++) {
      const cool = 1 - step / 360;
      for (const n of local) {const a = anchors.get(n.id); n.x += (a.x - n.x) * .005 * cool; n.y += (a.y - n.y) * .005 * cool;}
      for (const {a, b, type} of localLinks) {
        const dx = b.x - a.x, dy = b.y - a.y, distance = Math.hypot(dx, dy) || 1;
        const desired = Math.max((a.w + b.w) / 2 + gap + 22, (a.h + b.h) / 2 + gap + 22);
        const strength = ['CALL_RESULT', 'RESULT_OF', 'STATE_OF', 'VERSION_OF'].includes(type) ? .021 : .011;
        const force = (distance - desired) * strength * cool;
        a.x += dx / distance * force; a.y += dy / distance * force;
        b.x -= dx / distance * force; b.y -= dy / distance * force;
      }
      separate(local, 1);
    }
    // Resolve after all attraction, so no final spring step can reopen a collision.
    const residual = separate(local, 2000);
    if (residual) {
      // Bounded fallback for unusually large card dimensions or adversarial graphs.
      // This is only a display packing fallback, with a stagger rather than a snake.
      const cols = Math.ceil(Math.sqrt(local.length * 1.5));
      const w = Math.max(...local.map(n => n.w)) + gap + 30, h = Math.max(...local.map(n => n.h)) + gap + 30;
      local.forEach((n, i) => {n.x = i % cols * w + Math.sin(i * 1.7) * 10; n.y = Math.floor(i / cols) * h + Math.cos(i * 1.3) * 10;});
    }
    const minX = Math.min(...local.map(n => n.x - n.w / 2)), minY = Math.min(...local.map(n => n.y - n.h / 2));
    group.w = Math.max(...local.map(n => n.x + n.w / 2)) - minX + outer * 2;
    const extraWidth=Math.max(0,850-group.w);group.w+=extraWidth;
    for(const n of local)n.x+=extraWidth/2;
    group.h = Math.max(...local.map(n => n.y + n.h / 2)) - minY + outer * 2 + titleSpace;
    for (const n of local) {n.x -= minX - outer; n.y -= minY - outer - titleSpace;}
  }
  // Enumerate contiguous row partitions for small group counts. Packing fixed
  // group rectangles preserves stage order while adapting to asymmetric groups.
  const groupGap = 150, targetAspect = 2.05;
  function size(row) {return {w: row.reduce((sum, s) => sum + s.w, 0) + groupGap * (row.length - 1), h: Math.max(...row.map(s => s.h))};}
  let best;
  function consider(rows) {
    const sizes = rows.map(size), w = Math.max(...sizes.map(s => s.w)), h = sizes.reduce((sum, s) => sum + s.h, 0) + groupGap * (rows.length - 1);
    const filled = groups.reduce((sum, s) => sum + s.w * s.h, 0), cost = Math.abs(Math.log(w / h / targetAspect)) + (1 - filled / (w * h)) * .8;
    if (!best || cost < best.cost) best = {rows, sizes, w, h, cost};
  }
  if (groups.length <= 12) {
    for (let mask = 0; mask < 2 ** (groups.length - 1); mask++) {
      const rows = [[]];
      groups.forEach((s, i) => {rows.at(-1).push(s); if (i < groups.length - 1 && (mask & 2 ** i)) rows.push([]);});
      consider(rows);
    }
  } else for (let cols = 1; cols <= groups.length; cols++) {
    const rows = []; for (let i = 0; i < groups.length; i += cols) rows.push(groups.slice(i, i + cols)); consider(rows);
  }
  let y = 0;
  best.rows.forEach((row, i) => {
    let x = (best.w - best.sizes[i].w) / 2;
    for (const group of row) {
      group.x = x; group.y = y;
      for (const n of group.members) {n.x += x; n.y += y;}
      x += group.w + groupGap;
    }
    y += best.sizes[i].h + groupGap;
  });
  return {
    groups: groups.map(({members, ...s}) => ({...s, nodeCount: members.length, displayOnly: true})),
    bounds: {x: -45, y: -45, w: best.w + 90, h: best.h + 90}
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = {layoutLargeTAG};
