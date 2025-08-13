import * as admin from "firebase-admin";
import axios from "axios";
import sharp from "sharp";
import {v4 as uuidv4} from "uuid";
import {getBlurhash} from "./blurhash";

/**
 * Get already initialized Firebase bucket.
 * @returns {import("firebase-admin").storage.Storage}
 */
function getBucket() {
  return admin.storage().bucket();
}

/**
 * Compress an image to 512x512 and upload to Firebase Storage.
 *
 * @param {string} imageUrl URL of the image to download.
 * @param {object} [bucketRef] Firebase Storage bucket reference.
 * @param {string} mealId ID of the meal (used in filename).
 * @returns {Promise<{ photoUrl: string; blurhash: string }>}
 */
export async function compressAndUploadImage(
  imageUrl: string,
  bucketRef = getBucket(),
  mealId: string
): Promise<{ photoUrl: string; blurhash: string }> {
  const response = await axios.get<ArrayBuffer>(imageUrl, {
    responseType: "arraybuffer",
  });
  const buffer = Buffer.from(response.data);

  const resizedBuffer = await sharp(buffer)
    .resize(512, 512, {fit: "cover"})
    .jpeg({quality: 80})
    .toBuffer();

  const fileName = `meals/${mealId}-${uuidv4()}.jpg`;
  const downloadToken = uuidv4();

  await bucketRef.file(fileName).save(resizedBuffer, {
    contentType: "image/jpeg",
  });

  await bucketRef.file(fileName).setMetadata({
    metadata: {firebaseStorageDownloadTokens: downloadToken},
  });

  const blurhash = await getBlurhash(resizedBuffer);

  const photoUrl =
    "https://firebasestorage.googleapis.com/v0/b/" +
    bucketRef.name +
    "/o/" +
    encodeURIComponent(fileName) +
    "?alt=media&token=" +
    downloadToken;

  return {photoUrl, blurhash};
}
