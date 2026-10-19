// Scene files and batch renames are untrusted text; anything interpolated
// into an innerHTML template goes through this first.
export function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
