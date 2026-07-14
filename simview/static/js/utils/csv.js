// Pure CSV assembly (rows -> escaped CSV string) shared by ScalarPlotter and
// ErrorMetrics CSV export buttons, plus a small browser-only download helper.

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

// Triggers a browser download of `content` as a file named `filename`. No-op
// outside a browser environment (e.g. under vitest/node), so this module
// stays importable from tests without a DOM.
export function downloadCsv(filename, content) {
    if (typeof document === "undefined" || typeof Blob === "undefined") return;
    const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}
