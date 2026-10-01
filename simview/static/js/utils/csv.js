// Pure CSV assembly (rows -> escaped CSV string) shared by ScalarPlotter and
// ErrorMetrics CSV export buttons, plus small browser-only download helpers.

// Escapes a single CSV field per RFC 4180: wraps in double quotes if it
// contains a comma, double quote, or newline, doubling any embedded quotes.
export function escapeCsvField(field) {
    const str = field === null || field === undefined ? "" : String(field);
    if (/[",\n\r]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

// Builds a CSV string (CRLF line endings, per RFC 4180) from a header array
// and an array of rows (each row an array of values, same length as header).
export function rowsToCsv(header, rows) {
    const lines = [header, ...rows].map((row) =>
        row.map(escapeCsvField).join(",")
    );
    return lines.join("\r\n") + "\r\n";
}

// Sanitizes a string (e.g. a body or batch name) for safe use inside a
// downloaded filename: replaces anything but letters, digits, dot, dash, and
// underscore with underscores, so names containing spaces, slashes, etc.
// don't break the filename or path.
export function sanitizeForFilename(name) {
    const str = name === null || name === undefined ? "" : String(name);
    return str.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

// Triggers a browser download of `blob` named `filename` via a temporary
// <a download> link.
export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    // Revoke on a delay rather than immediately: some browsers kick off the
    // download asynchronously, and revoking the URL too early can abort it.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Downloads `content` as a CSV file. No-op outside a browser environment
// (e.g. under vitest/node), so this module stays importable without a DOM.
export function downloadCsv(filename, content) {
    if (typeof document === "undefined" || typeof Blob === "undefined") return;
    downloadBlob(new Blob([content], { type: "text/csv;charset=utf-8;" }), filename);
}
