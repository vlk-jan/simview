// Time-ranged visibility (see json-format.md `visibleRanges`): an object with
// ranges is shown only while the playhead is inside one of its
// [t_from, t_to] pairs (inclusive). No/empty ranges means always visible.
export function isVisibleAt(ranges, t) {
    if (!Array.isArray(ranges) || ranges.length === 0) return true;
    return ranges.some((r) => Array.isArray(r) && t >= r[0] && t <= r[1]);
}
