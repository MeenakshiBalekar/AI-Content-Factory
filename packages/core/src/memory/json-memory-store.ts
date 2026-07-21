import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Episode } from "../domain/episode.ts";
import { asChannelId, type ChannelId } from "../domain/ids.ts";
import {
  UnknownChannelError,
  type ChannelMemory,
  type MemoryStore,
} from "./memory-store.ts";

/**
 * File-backed MemoryStore: one JSON document per channel under `<root>/<channelId>.json`.
 * Real persistence — memory survives across CLI invocations. Writes are atomic
 * (temp file + rename) so a crash mid-write can't corrupt existing memory.
 */
export class JsonMemoryStore implements MemoryStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  #pathFor(channelId: ChannelId): string {
    return join(this.#root, `${channelId}.json`);
  }

  async #ensureRoot(): Promise<void> {
    if (!existsSync(this.#root)) {
      await mkdir(this.#root, { recursive: true });
    }
  }

  async listChannels(): Promise<ChannelId[]> {
    if (!existsSync(this.#root)) return [];
    const files = await readdir(this.#root);
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => asChannelId(f.slice(0, -".json".length)));
  }

  async load(channelId: ChannelId): Promise<ChannelMemory | undefined> {
    const path = this.#pathFor(channelId);
    if (!existsSync(path)) return undefined;
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as ChannelMemory;
  }

  async save(memory: ChannelMemory): Promise<void> {
    await this.#ensureRoot();
    const path = this.#pathFor(memory.channel.id);
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(memory, null, 2), "utf8");
    // rename is atomic on the same filesystem — readers never see a partial file.
    const { rename } = await import("node:fs/promises");
    await rename(tmp, path);
  }

  async appendEpisode(channelId: ChannelId, episode: Episode): Promise<void> {
    const memory = await this.load(channelId);
    if (!memory) throw new UnknownChannelError(channelId);
    await this.save({ ...memory, episodes: [...memory.episodes, episode] });
  }
}
