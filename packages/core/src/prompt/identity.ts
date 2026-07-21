import { createHash } from "node:crypto";
import type { Character } from "../domain/character.ts";
import type { ChannelId } from "../domain/ids.ts";

/**
 * Identity locking.
 *
 * The problem: image/video models are stochastic, so the same character drifts between
 * generations. The fix has two parts, both deterministic:
 *
 *  1. A stable numeric *seed* derived from the channel + character + immutable appearance.
 *     Passing the same seed to a diffusion provider anchors composition run-to-run.
 *
 *  2. A canonical *identity fragment* — a fixed descriptive sentence built from the locked
 *     appearance — that is injected verbatim into every visual prompt featuring the
 *     character. The model is never asked to re-invent what the character looks like.
 *
 * Because both are pure functions of the locked appearance, they are identical in Episode 1
 * and Episode 248. That is the whole guarantee.
 */

/** Deterministic 32-bit seed from the fields that must never change. */
export function identitySeed(channelId: ChannelId, character: Character): number {
  const a = character.appearance;
  const material = [
    channelId,
    character.id,
    a.species,
    a.ageDescription,
    a.build,
    a.face,
    a.hair,
    a.eyes,
    a.outfit,
    a.accessories.join(","),
    a.palette.join(","),
  ].join("|");
  const digest = createHash("sha256").update(material).digest();
  // First 4 bytes as an unsigned 31-bit int (many providers cap seeds at 2^31-1).
  return digest.readUInt32BE(0) % 2_147_483_647;
}

/** The canonical, always-injected description of the character's appearance. */
export function identityFragment(character: Character): string {
  const a = character.appearance;
  const accessories = a.accessories.length
    ? `, wearing ${a.accessories.join(" and ")}`
    : "";
  return (
    `${character.name}, a ${a.ageDescription} ${a.species}, ${a.build}, ` +
    `with ${a.hair} and ${a.eyes}; ${a.face}; dressed in ${a.outfit}${accessories}. ` +
    `Signature palette: ${a.palette.join(", ")}.`
  );
}

/** A short color/style token list appended for graders and thumbnail consistency. */
export function paletteToken(character: Character): string {
  return character.appearance.palette.join(" ");
}
