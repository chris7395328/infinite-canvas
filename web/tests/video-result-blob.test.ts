import { expect, test } from "bun:test";
import { normalizeVideoResultBlob } from "../src/lib/video-result-blob";

// Minimal ISO BMFF ftyp signature; type detection is not a full integrity check.
const mp4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109, 109, 112, 52, 50]);
for (const mime of ["binary/octet-stream", "application/octet-stream", "binary/octet-stream; charset=utf-8", ""]) {
    test(`recover MP4 with transport MIME ${mime || "missing"}`, async () => {
        const blob = new Blob([mp4], { type: mime });
        const recovered = await normalizeVideoResultBlob(blob);
        expect(recovered.type).toBe("video/mp4");
        expect(await recovered.arrayBuffer()).toEqual(await blob.arrayBuffer());
    });
}
test("preserve video MIME", async () => {
    const blob = new Blob([mp4], { type: "video/mp4" });
    expect(await normalizeVideoResultBlob(blob)).toBe(blob);
});
for (const body of ["", "{\"id\":\"task_example\",\"status\":\"completed\"}", "<html>error</html>", "not a video"]) {
    test(`reject non-video transport payload ${body || "empty"}`, async () => {
        await expect(normalizeVideoResultBlob(new Blob([body], { type: "binary/octet-stream" }))).rejects.toThrow();
    });
}
test("reject JSON content type even if mislabeled bytes resemble MP4", async () => {
    await expect(normalizeVideoResultBlob(new Blob([mp4], { type: "application/json" }))).rejects.toThrow();
});
