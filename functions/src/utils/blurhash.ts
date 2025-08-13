import sharp from "sharp";
import {encode} from "blurhash";

/**
 * Generate a blurhash string for an image buffer.
 *
 * @param {Buffer} buffer Image buffer (JPEG/PNG).
 * @returns {Promise<string>} Blurhash string.
 */
export async function getBlurhash(buffer: Buffer): Promise<string> {
  const {data, info} = await sharp(buffer)
    .raw()
    .ensureAlpha()
    .resize(100, 100, {fit: "inside"})
    .toBuffer({resolveWithObject: true});

  return encode(
    new Uint8ClampedArray(data),
    info.width,
    info.height,
    4,
    4
  );
}
