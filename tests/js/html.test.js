import { describe, expect, it } from "vitest";
import { escapeHtml } from "../../simview/static/js/utils/html.js";

describe("escapeHtml", () => {
    it("leaves no markup or quote characters behind", () => {
        const out = escapeHtml(`"x' <img src=y onerror=alert(1)> a&b`);
        expect(out).not.toMatch(/[<>"']/);
        expect(out).toBe("&#34;x&#39; &#60;img src=y onerror=alert(1)&#62; a&#38;b");
        expect(escapeHtml(3)).toBe("3");
    });
});
