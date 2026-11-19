import { describe, expect, it } from "bun:test";
import { AssetStorage } from "../assetStorage";

// maxSize keeps every save() call in these tests from reaching the disk:
// validation failures all return before the file is written.
const logoStorage = new AssetStorage({
  subPath: "organizations/logos",
  fileTypes: ["image/png", "image/jpeg"],
  maxSize: 10,
});

describe("AssetStorage constructor", () => {
  it("rejects unusable sub paths", () => {
    for (const subPath of ["", " ", ".", ".."]) {
      expect(() =>
        new AssetStorage({ subPath, fileTypes: ["image/png"] }),
      ).toThrow("AssetStorage: subPath must be a non-empty relative path");
    }
  });

  it("requires at least one allowed file type", () => {
    expect(() =>
      new AssetStorage({ subPath: "organizations/logos", fileTypes: [] }),
    ).toThrow("AssetStorage: fileTypes must not be empty");
  });
});

describe("AssetStorage save validation", () => {
  it("rejects a missing file", async () => {
    expect(await logoStorage.save(undefined as unknown as File)).toEqual({
      ok: false,
      error: "no file provided",
    });
  });

  it("rejects unsupported file types", async () => {
    expect(
      await logoStorage.save(new File(["x"], "logo.gif", { type: "image/gif" })),
    ).toEqual({ ok: false, error: "unsupported file type: image/gif" });

    expect(
      await logoStorage.save(new File(["x"], "logo", { type: "" })),
    ).toEqual({ ok: false, error: "unsupported file type: unknown" });
  });

  it("rejects files above the size limit", async () => {
    expect(
      await logoStorage.save(
        new File([new Uint8Array(11)], "logo.png", { type: "image/png" }),
      ),
    ).toEqual({ ok: false, error: "file exceeds the maximum size of 10 bytes" });
  });

  it("matches the MIME type without its parameters", async () => {
    // the size error proves the type passed validation once the parameter
    // was stripped; the request never reaches the disk either way
    expect(
      await logoStorage.save(
        new File([new Uint8Array(11)], "logo.png", {
          type: "image/png; charset=utf-8",
        }),
      ),
    ).toEqual({ ok: false, error: "file exceeds the maximum size of 10 bytes" });
  });
});
