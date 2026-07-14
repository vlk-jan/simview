import { describe, expect, it } from "vitest";
import {
    escapeCsvField,
    rowsToCsv,
    sanitizeForFilename,
} from "../../simview/static/js/utils/csv.js";

describe("escapeCsvField", () => {
    it("leaves plain values unquoted", () => {
        expect(escapeCsvField("abc")).toBe("abc");
        expect(escapeCsvField(123)).toBe("123");
        expect(escapeCsvField(1.5)).toBe("1.5");
    });

    it("returns an empty string for null/undefined", () => {
        expect(escapeCsvField(null)).toBe("");
        expect(escapeCsvField(undefined)).toBe("");
    });

    it("quotes values containing commas", () => {
        expect(escapeCsvField("a,b")).toBe('"a,b"');
    });

    it("quotes and doubles embedded double quotes", () => {
        expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    });

    it("quotes values containing newlines", () => {
        expect(escapeCsvField("a\nb")).toBe('"a\nb"');
        expect(escapeCsvField("a\r\nb")).toBe('"a\r\nb"');
    });
});

describe("rowsToCsv", () => {
    it("joins header and rows with commas and CRLF line endings", () => {
        const csv = rowsToCsv(
            ["time", "value"],
            [
                [0, 1.5],
                [1, 2.5],
            ]
        );
        expect(csv).toBe("time,value\r\n0,1.5\r\n1,2.5\r\n");
    });

    it("escapes fields that need it within rows", () => {
        const csv = rowsToCsv(["name", "note"], [["Batch, A", 'quote "here"']]);
        expect(csv).toBe('name,note\r\n"Batch, A","quote ""here"""\r\n');
    });

    it("handles an empty row set, producing only the header line", () => {
        const csv = rowsToCsv(["time", "value"], []);
        expect(csv).toBe("time,value\r\n");
    });
});

describe("sanitizeForFilename", () => {
    it("leaves safe characters untouched", () => {
        expect(sanitizeForFilename("real_world-1.2")).toBe("real_world-1.2");
    });

    it("replaces unsafe characters (spaces, slashes) with underscores", () => {
        expect(sanitizeForFilename("real world/batch 1")).toBe("real_world_batch_1");
    });

    it("collapses runs of unsafe characters into a single underscore", () => {
        expect(sanitizeForFilename("a,,,b")).toBe("a_b");
    });

    it("returns an empty string for null/undefined", () => {
        expect(sanitizeForFilename(null)).toBe("");
        expect(sanitizeForFilename(undefined)).toBe("");
    });
});
