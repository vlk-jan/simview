// True when a keyboard event comes from a form field the user is typing in,
// so global shortcuts should stay out of the way. Text-like <input>s,
// <textarea>, <select> and contentEditable count; button-like inputs
// (button/checkbox/radio/range/submit/...) do not.
const NON_TEXT_INPUTS = new Set(["button", "checkbox", "radio", "range", "submit", "reset", "image", "file", "color"]);

export function isEditableTarget(event) {
    let el = event.target;
    if (!el || !el.tagName) el = typeof document !== "undefined" ? document.activeElement : null;
    if (!el) return false;
    if (el.isContentEditable) return true;
    switch (el.tagName) {
        case "INPUT":
            return !NON_TEXT_INPUTS.has((el.type || "text").toLowerCase());
        case "TEXTAREA":
        case "SELECT":
            return true;
        default:
            return false;
    }
}
