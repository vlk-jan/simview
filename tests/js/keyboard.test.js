import { afterEach, describe, expect, it } from "vitest";
import { isEditableTarget } from "../../simview/static/js/utils/keyboard.js";

const ev = (target) => ({ target });

describe("isEditableTarget", () => {
    afterEach(() => {
        delete globalThis.document;
    });

    it("is true for text inputs, textarea, select, contentEditable", () => {
        expect(isEditableTarget(ev({ tagName: "INPUT", type: "text" }))).toBe(true);
        expect(isEditableTarget(ev({ tagName: "INPUT" }))).toBe(true);
        expect(isEditableTarget(ev({ tagName: "TEXTAREA" }))).toBe(true);
        expect(isEditableTarget(ev({ tagName: "SELECT" }))).toBe(true);
        expect(isEditableTarget(ev({ tagName: "DIV", isContentEditable: true }))).toBe(true);
    });

    it("is false for buttons, checkboxes, canvas and body", () => {
        expect(isEditableTarget(ev({ tagName: "BUTTON" }))).toBe(false);
        expect(isEditableTarget(ev({ tagName: "INPUT", type: "checkbox" }))).toBe(false);
        expect(isEditableTarget(ev({ tagName: "INPUT", type: "range" }))).toBe(false);
        expect(isEditableTarget(ev({ tagName: "CANVAS" }))).toBe(false);
        expect(isEditableTarget(ev({ tagName: "BODY" }))).toBe(false);
    });

    it("falls back to document.activeElement for window/null targets", () => {
        expect(isEditableTarget(ev(null))).toBe(false);
        globalThis.document = { activeElement: { tagName: "TEXTAREA" } };
        expect(isEditableTarget(ev({}))).toBe(true);
        expect(isEditableTarget(ev(null))).toBe(true);
    });
});
