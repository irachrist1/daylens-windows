// Calendar-track card heights.
//
// A card sits at its wall-clock position and its height is its duration.
// The readability floor (a just-started or sliver block still needs a
// clickable card) used to be applied blindly: `max(minHeight, durationPx)`
// with the top pinned at the true start meant a short block PAINTED PAST ITS
// REAL END — covering the idle gap below it, its "Idle · 12m" caption, and
// sometimes the next block's header.
//
// The rule here: the floor may stretch a card into genuinely empty space it
// does not distort, but it must never reach the next block's top. When the
// floor doesn't fit, the card falls back to its truthful proportional height —
// the clock wins over the floor, never the other way around.

export interface LayoutBlockSpan {
  // Pixel offset of the block's start on the track.
  top: number
  // Pixel offset of the block's (layout) end on the track.
  bottom: number
}

// Breathing room kept between a floored card and the next card's top, so two
// adjacent cards never visually fuse.
const CARD_CLEARANCE_PX = 2

export function calendarCardHeights(spans: LayoutBlockSpan[], minHeight: number): number[] {
  return spans.map((span, index) => {
    const trueHeight = Math.max(1, span.bottom - span.top)
    const floored = Math.max(minHeight, trueHeight)
    const next = spans[index + 1]
    if (!next) return floored
    const available = next.top - span.top - CARD_CLEARANCE_PX
    // The floor only applies when it fits in front of the next block; a real
    // (true-duration) overlap is drawn as-is rather than silently shrunk.
    if (floored > available) return Math.max(trueHeight, Math.min(floored, available))
    return floored
  })
}

export interface LaneItem {
  start: number
  end: number
}

export interface LanePlacement {
  // 0-based column index within the item's overlap cluster.
  lane: number
  // Number of columns the cluster spans — the divisor for the item's width.
  lanes: number
}

// Google-Calendar column layout: items that overlap in time are placed
// side by side in the fewest columns that keep them from covering each other,
// so an event over a block reads as two adjacent cards, both clickable. A
// maximal run of transitively-overlapping items forms one cluster; every item
// in it shares the same column count so their widths line up. Returns one
// placement per input item, in input order.
export function assignLanes(items: LaneItem[]): LanePlacement[] {
  const placement: LanePlacement[] = items.map(() => ({ lane: 0, lanes: 1 }))
  const order = items
    .map((item, index) => ({ index, start: item.start, end: item.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end)

  let cluster: number[] = []
  let clusterEnd = -Infinity
  let columnEnds: number[] = []

  const closeCluster = () => {
    const lanes = Math.max(1, columnEnds.length)
    for (const original of cluster) placement[original].lanes = lanes
    cluster = []
    columnEnds = []
    clusterEnd = -Infinity
  }

  for (const item of order) {
    // A start at or after every active end means this item overlaps nothing in
    // the current cluster — the cluster is complete.
    if (cluster.length > 0 && item.start >= clusterEnd) closeCluster()
    let lane = columnEnds.findIndex((end) => end <= item.start)
    if (lane === -1) {
      lane = columnEnds.length
      columnEnds.push(item.end)
    } else {
      columnEnds[lane] = item.end
    }
    placement[item.index].lane = lane
    cluster.push(item.index)
    clusterEnd = Math.max(clusterEnd, item.end)
  }
  if (cluster.length > 0) closeCluster()
  return placement
}
