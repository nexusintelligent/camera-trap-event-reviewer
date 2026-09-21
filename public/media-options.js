export const MAX_PHOTOS_PER_EVENT = 100;

export function isVideoFile(filename) {
  return /\.(avi|mp4|mov)$/i.test(filename);
}

export function importOptions(input = {}) {
  const photosPerEvent = input.photosPerEvent ?? 3;
  const includeVideos = input.includeVideos ?? true;
  if (!Number.isInteger(photosPerEvent) || photosPerEvent < 1 || photosPerEvent > MAX_PHOTOS_PER_EVENT) {
    throw new Error(`每組照片張數必須為 1 到 ${MAX_PHOTOS_PER_EVENT} 的整數。`);
  }
  if (typeof includeVideos !== "boolean") throw new Error("是否辨識影片必須選擇是或否。");
  return { photosPerEvent, includeVideos };
}

export function photoEntries(event) {
  let photos;
  try { photos = Array.isArray(event.PhotoFiles) ? event.PhotoFiles : JSON.parse(event.PhotoFiles || "null"); } catch { /* Legacy CSV. */ }
  if (!Array.isArray(photos)) photos = [event.Photo1, event.Photo2, event.Photo3];
  return photos.map((token, index) => ({ field: `Photo${index + 1}`, token })).filter(({ token }) => typeof token === "string" && token);
}

export function fastPhotoEntries(event) {
  const photos = photoEntries(event);
  return photos.length > 1 ? [photos[0], photos.at(-1)] : photos;
}

export function eventMediaEntries(event) {
  return [...photoEntries(event), ...(event.Video ? [{ field: "Video", token: event.Video }] : [])];
}

export function shouldUseVideo(event) {
  return Boolean(event.Video) && event.IncludeVideos !== "no";
}
