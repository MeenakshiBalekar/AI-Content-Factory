import { DatabaseSync } from "node:sqlite";
import type { Episode } from "../domain/episode.ts";
import { asChannelId, type ChannelId } from "../domain/ids.ts";
import {
  UnknownChannelError,
  type ChannelMemory,
  type MemoryStore,
} from "./memory-store.ts";

/**
 * SQL-backed MemoryStore using Node's built-in SQLite. Same interface as JsonMemoryStore, so
 * the orchestrator and API are storage-agnostic; the schema (channels + episodes tables,
 * episode rows separate from the channel document) mirrors the future Postgres/Prisma layout,
 * so the migration is a driver swap, not a redesign.
 *
 * Episodes live in their own table — appending an episode is an INSERT, not a rewrite of the
 * whole memory document, which is what makes this scale past JSON files.
 */
export class SqliteMemoryStore implements MemoryStore {
  readonly #db: DatabaseSync;

  /** @param path SQLite file path, or ":memory:" for tests. */
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS channels (
        id         TEXT PRIMARY KEY,
        document   TEXT NOT NULL,           -- ChannelMemory minus episodes (JSON)
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS episodes (
        id         TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        number     INTEGER NOT NULL,
        document   TEXT NOT NULL,           -- full Episode (JSON)
        created_at TEXT NOT NULL,
        UNIQUE (channel_id, number)
      );
      CREATE INDEX IF NOT EXISTS idx_episodes_channel ON episodes (channel_id, number);
    `);
  }

  async listChannels(): Promise<ChannelId[]> {
    const rows = this.#db.prepare("SELECT id FROM channels ORDER BY id").all() as { id: string }[];
    return rows.map((r) => asChannelId(r.id));
  }

  async load(channelId: ChannelId): Promise<ChannelMemory | undefined> {
    const row = this.#db
      .prepare("SELECT document FROM channels WHERE id = ?")
      .get(channelId) as { document: string } | undefined;
    if (!row) return undefined;

    const base = JSON.parse(row.document) as Omit<ChannelMemory, "episodes">;
    const epRows = this.#db
      .prepare("SELECT document FROM episodes WHERE channel_id = ? ORDER BY number")
      .all(channelId) as { document: string }[];

    return { ...base, episodes: epRows.map((r) => JSON.parse(r.document) as Episode) };
  }

  async save(memory: ChannelMemory): Promise<void> {
    const { episodes, ...base } = memory;
    const now = new Date().toISOString();
    const upsertChannel = this.#db.prepare(
      `INSERT INTO channels (id, document, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET document = excluded.document, updated_at = excluded.updated_at`,
    );
    const upsertEpisode = this.#db.prepare(
      `INSERT INTO episodes (id, channel_id, number, document, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET document = excluded.document`,
    );

    this.#db.exec("BEGIN");
    try {
      upsertChannel.run(memory.channel.id, JSON.stringify(base), now);
      for (const ep of episodes) {
        upsertEpisode.run(ep.id, ep.channelId, ep.number, JSON.stringify(ep), ep.createdAt);
      }
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  async appendEpisode(channelId: ChannelId, episode: Episode): Promise<void> {
    const exists = this.#db.prepare("SELECT 1 FROM channels WHERE id = ?").get(channelId);
    if (!exists) throw new UnknownChannelError(channelId);
    this.#db
      .prepare(
        "INSERT INTO episodes (id, channel_id, number, document, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(episode.id, channelId, episode.number, JSON.stringify(episode), episode.createdAt);
  }

  close(): void {
    this.#db.close();
  }
}
