import { describe, expect, it } from "vitest";
import {
    decodeFloat32Blob,
    decodeStateField,
    decodeStatesChunk,
    STATE_FIELD_WIDTHS,
} from "../../simview/static/js/utils/blobCodec.js";

// Known little-endian float32 bytes for [1.5, -2.25, 3.0, 0.5, -0.5, 0.25, 100.125],
// generated with Python's struct.pack("<7f", ...) to match the server's encoding.
const KNOWN_VALUES = [1.5, -2.25, 3.0, 0.5, -0.5, 0.25, 100.125];
const KNOWN_B64 = "AADAPwAAEMAAAEBAAAAAPwAAAL8AAIA+AEDIQg==";

describe("decodeFloat32Blob", () => {
    it("round-trips known little-endian float32 bytes", () => {
        const bin = atob(KNOWN_B64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const floats = decodeFloat32Blob(bytes.buffer);
        expect(Array.from(floats)).toEqual(
            KNOWN_VALUES.map((v) => Math.fround(v))
        );
    });
});

describe("decodeStateField", () => {
    it("decodes a __b64__-prefixed string into rows of the given width", () => {
        const rows = decodeStateField("__b64__" + KNOWN_B64, 7);
        expect(rows).toHaveLength(1);
        rows[0].forEach((v, i) => expect(v).toBeCloseTo(KNOWN_VALUES[i], 5));
    });

    it("reshapes into multiple per-batch rows when width divides evenly", () => {
        // Two batches of width 3: [1,2,3] and [4,5,6].
        const rows3 = [1, 2, 3, 4, 5, 6];
        const bin = new Uint8Array(new Float32Array(rows3).buffer);
        let s = "";
        for (const b of bin) s += String.fromCharCode(b);
        const b64 = btoa(s);
        const decoded = decodeStateField("__b64__" + b64, 3);
        expect(decoded).toEqual([
            [1, 2, 3],
            [4, 5, 6],
        ]);
    });
});

describe("STATE_FIELD_WIDTHS", () => {
    it("declares the expected per-body fields and widths", () => {
        expect(STATE_FIELD_WIDTHS).toEqual({
            bodyTransform: 7,
            velocity: 3,
            angularVelocity: 3,
            force: 3,
            torque: 3,
        });
    });
});

describe("decodeStatesChunk", () => {
    it("decodes only __b64__ fields and leaves plain-JSON fields untouched", () => {
        const plainTransform = [[0, 0, 0, 1, 0, 0, 0]];
        const chunk = [
            {
                time: 0,
                bodies: [
                    { name: "a", bodyTransform: plainTransform },
                    { name: "b", bodyTransform: "__b64__" + KNOWN_B64 },
                ],
            },
        ];
        decodeStatesChunk(chunk);
        expect(chunk[0].bodies[0].bodyTransform).toBe(plainTransform);
        expect(chunk[0].bodies[1].bodyTransform).toHaveLength(1);
        chunk[0].bodies[1].bodyTransform[0].forEach((v, i) =>
            expect(v).toBeCloseTo(KNOWN_VALUES[i], 5)
        );
    });

    it("skips states without a bodies array", () => {
        const chunk = [{ time: 0 }];
        expect(() => decodeStatesChunk(chunk)).not.toThrow();
        expect(chunk).toEqual([{ time: 0 }]);
    });
});
