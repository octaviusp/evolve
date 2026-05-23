import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ingestCursorEvidence } from "../src/cursor/ingest.js";
import { openEvolveDatabase, recordEvidence } from "../src/storage/database.js";
import { makeTempRoot, makeTestConfig } from "./helpers.js";

describe("cursor ingestion", () => {
  it("reads Cursor bubble rows read-only and deduplicates evidence", async () => {
    const root = await makeTempRoot("cursor-ingest");
    const config = makeTestConfig(root);
    const cursorDb = new Database(config.cursor.appDb);
    cursorDb.exec("CREATE TABLE cursorDiskKV (key TEXT UNIQUE, value BLOB)");
    cursorDb
      .prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)")
      .run(
        "bubbleId:composer:bubble",
        Buffer.from(
          JSON.stringify({
            type: 1,
            text: "The test failed again because the Cursor skill hook missed this regression.",
          }),
        ),
      );
    cursorDb.close();

    const handle = await openEvolveDatabase(config);
    try {
      const first = ingestCursorEvidence(config, handle.db);
      expect(first.cards).toHaveLength(1);
      recordEvidence(handle.db, first.cards[0]);
      const second = ingestCursorEvidence(config, handle.db);
      expect(second.cards).toHaveLength(0);
    } finally {
      handle.close();
    }
  });
});
