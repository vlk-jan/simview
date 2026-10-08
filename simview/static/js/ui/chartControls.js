import { rowsToCsv } from "../utils/csv.js";

// Small pieces shared by the Analysis panels (ScalarPlotter, ErrorMetrics,
// TerrainProfile). Kept free of uPlot/config imports so they test in Node.

// Index (0-based, i.e. batch) of the series whose value at `dataIdx` is
// closest to `yVal`, or -1 if none has a value there.
export function closestSeries(u, dataIdx, yVal) {
    let best = -1;
    let bestDist = Infinity;
    for (let i = 1; i < u.data.length; i++) {
        const y = u.data[i][dataIdx];
        if (y === null || y === undefined) continue;
        const dist = Math.abs(y - yVal);
        if (dist < bestDist) {
            bestDist = dist;
            best = i - 1;
        }
    }
    return best;
}

// [min, max] over the finite y of every batch's {x, y} points; [0, 1] when
// there are none, so a chart never gets NaN/Infinity bounds.
export function finiteBounds(seriesPerBatch) {
    let min = Infinity;
    let max = -Infinity;
    for (const batchSeries of seriesPerBatch) {
        for (const { y } of batchSeries) {
            if (!Number.isFinite(y)) continue;
            if (y < min) min = y;
            if (y > max) max = y;
        }
    }
    return min <= max ? [min, max] : [0, 1];
}

// CSV with a time column, then one column per batch (named after the batch's
// display name); `seriesPerBatch[b][i]` is an {x, y} point or missing.
export function batchColumnsCsv(batchManager, times, seriesPerBatch) {
    const batchCount = batchManager.simBatches;
    const header = ["time"];
    for (let b = 0; b < batchCount; b++) {
        header.push(batchManager.getBatchName(b) || `batch_${b}`);
    }
    const rows = times.map((t, idx) => {
        const row = [t];
        for (let b = 0; b < batchCount; b++) {
            const point = seriesPerBatch[b] && seriesPerBatch[b][idx];
            row.push(point && point.y != null ? point.y : "");
        }
        return row;
    });
    return rowsToCsv(header, rows);
}

// "Export CSV" button, right-aligned in its own bar.
export function exportBar(onClick) {
    const bar = document.createElement("div");
    bar.className = "sv-export-bar";
    const button = document.createElement("button");
    button.textContent = "Export CSV";
    button.addEventListener("click", onClick);
    bar.appendChild(button);
    return bar;
}

// A "Label: [select]" control group appended to `parent`. `options` are
// {value, label}; returns the <select>.
export function selectGroup(parent, labelText, options, selectedValue) {
    const group = document.createElement("div");
    group.className = "sv-control-group";
    const label = document.createElement("label");
    label.textContent = labelText;
    const select = document.createElement("select");
    for (const { value, label: optLabel } of options) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = optLabel;
        if (value === selectedValue) option.selected = true;
        select.appendChild(option);
    }
    group.appendChild(label);
    group.appendChild(select);
    parent.appendChild(group);
    return select;
}
