import * as THREE from "three";

// Resolves parent-relative body transforms (see README.md "Model (Static
// Data)" / "States (Dynamic Data)") into ordinary absolute-world transforms,
// so the rest of the viewer (Body.js, InteractionController.js, trails, ...)
// never has to know a body was parented -- it only ever sees the same
// `bodyTransform` shape it always has.

// Builds a `name -> {parent, localTransform}` lookup from `model.bodies`.
// `parent`/`localTransform` are null for an ordinary absolute-world body.
export function buildBodyMeta(modelBodies) {
    const meta = new Map();
    (modelBodies || []).forEach((b) => {
        meta.set(b.name, {
            parent: b.parent ?? null,
            localTransform: b.localTransform ?? null,
        });
    });
    return meta;
}

// Orders body names so every parent precedes its children. Each body has at
// most one parent (a forest, not a general DAG), so a plain DFS post-order
// walk suffices -- no need for a full topological-sort algorithm. Throws on
// a self-referencing, unknown, or cyclic parent chain, mirroring the
// SimViewModel.add_body/from_dict validation on the Python side (this exists
// on the client because loaded JSON has no equivalent insertion-order
// guarantee -- it may have been hand-edited or produced by another tool).
export function topoSortBodies(bodyMeta) {
    const order = [];
    const status = new Map(); // name -> "visiting" | "done"

    function visit(name) {
        if (status.get(name) === "done") return;
        if (status.get(name) === "visiting") {
            throw new Error(`Cycle detected in body parent chain involving '${name}'`);
        }
        const meta = bodyMeta.get(name);
        if (meta.parent != null) {
            if (meta.parent === name) {
                throw new Error(`Body '${name}' cannot be its own parent`);
            }
            if (!bodyMeta.has(meta.parent)) {
                throw new Error(
                    `Body '${name}' references unknown parent '${meta.parent}'`
                );
            }
            status.set(name, "visiting");
            visit(meta.parent);
        }
        status.set(name, "done");
        order.push(name);
    }

    for (const name of bodyMeta.keys()) {
        visit(name);
    }
    return order;
}

function posFromWire(t) {
    return new THREE.Vector3(t[0], t[1], t[2]);
}

// Wire order is [x, y, z, w, qx, qy, qz]; THREE.Quaternion.set() takes (x, y, z, w).
function quatFromWire(t) {
    return new THREE.Quaternion(t[4], t[5], t[6], t[3]);
}

function wireFromPosQuat(pos, quat) {
    return [pos.x, pos.y, pos.z, quat.w, quat.x, quat.y, quat.z];
}

// Normalizes a bodyTransform field (flat array[7] for a single batch, or
// array[array[7]] for multiple) into a plain array of rows, matching the
// same convention Body.js already uses when consuming raw state data.
function toRows(bodyTransform) {
    return Array.isArray(bodyTransform[0]) ? bodyTransform : [bodyTransform];
}

// Builds a `name -> rawStateEntry` lookup for one state's `bodies` array,
// expanding any grouped (list) `name` entries so each individual body name
// maps to the (shared) entry describing it.
function expandRawBodies(rawBodies) {
    const map = new Map();
    (rawBodies || []).forEach((entry) => {
        const names = Array.isArray(entry.name) ? entry.name : [entry.name];
        names.forEach((n) => map.set(n, entry));
    });
    return map;
}

// Resolves one state's raw `bodies` array into a `name -> resolvedBodyState`
// Map where every body's `bodyTransform` is absolute-world, ready to feed
// straight into Body.updateState / appendHistoryPointAt / setHistoryPointAt
// unchanged. A body absent from the result simply keeps whatever pose it
// already had (identical to today's behavior when a body is omitted from a
// state). `bodyMeta`/`topoOrder` come from `buildBodyMeta`/`topoSortBodies`,
// computed once at model load.
export function resolveStateBodies(bodyMeta, topoOrder, simBatches, rawBodies) {
    const rawByName = expandRawBodies(rawBodies);
    const resolved = new Map();

    for (const name of topoOrder) {
        const meta = bodyMeta.get(name);
        const raw = rawByName.get(name);

        if (meta.parent == null) {
            // Root body: bodyTransform, if present this frame, is already
            // absolute-world -- nothing to resolve.
            if (raw && raw.bodyTransform) {
                resolved.set(name, raw);
            }
            continue;
        }

        const parentResolved = resolved.get(meta.parent);
        if (!parentResolved || !parentResolved.bodyTransform) {
            // Parent has no resolved pose this frame; nothing sensible to
            // compose this child against.
            continue;
        }
        const parentRows = toRows(parentResolved.bodyTransform);

        let localRows;
        if (meta.localTransform) {
            // Rigid attachment: same constant local offset for every batch.
            localRows = [meta.localTransform];
        } else if (raw && raw.bodyTransform) {
            // Articulated attachment: per-frame local transform, as usual.
            localRows = toRows(raw.bodyTransform);
        } else {
            continue; // no data to resolve this body this frame
        }

        const worldRows = [];
        for (let i = 0; i < simBatches; i++) {
            const parentRow = parentRows[Math.min(i, parentRows.length - 1)];
            const localRow = localRows[Math.min(i, localRows.length - 1)];
            const worldPos = posFromWire(localRow)
                .applyQuaternion(quatFromWire(parentRow))
                .add(posFromWire(parentRow));
            const worldQuat = quatFromWire(parentRow).multiply(quatFromWire(localRow));
            worldRows.push(wireFromPosQuat(worldPos, worldQuat));
        }

        resolved.set(name, { ...(raw || {}), bodyTransform: worldRows });
    }

    return resolved;
}
