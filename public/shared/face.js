// Face check for the clock-in selfie: MediaPipe BlazeFace (served by this app from /vendor), runs on the device.
// checkFace(): is there exactly one clear face in the photo · yawOf(): how far the head is turned (for the liveness turn).
let imgDet = null, vidDet = null;
async function make(mode) {
  const v = await import('/vendor/mediapipe/vision_bundle.mjs');
  const files = await v.FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
  return v.FaceDetector.createFromOptions(files, { baseOptions: { modelAssetPath: '/vendor/blaze_face_short_range.tflite' }, runningMode: mode, minDetectionConfidence: 0.5 });
}
export const imageDetector = () => (imgDet ||= make('IMAGE').catch((e) => { imgDet = null; throw e; }));
export const videoDetector = () => (vidDet ||= make('VIDEO').catch((e) => { vidDet = null; throw e; }));

// keypoints: 0 right eye, 1 left eye, 2 nose tip (normalised 0..1). 0 = facing the camera, ± = turned
export function yawOf(det) {
  const k = det && det.keypoints;
  if (!k || k.length < 3) return 0;
  const eyes = Math.abs(k[0].x - k[1].x) || 1e-3;
  return (k[2].x - (k[0].x + k[1].x) / 2) / eyes;
}

// one clear face, big enough in the frame
export async function checkFace(src) {
  const d = await imageDetector();
  const w = src.naturalWidth || src.videoWidth || src.width;
  const faces = (d.detect(src).detections || []).filter((f) => (f.categories[0] || {}).score >= 0.6);
  if (!faces.length) return { ok: false, reason: 'ไม่พบใบหน้าในรูป — มองกล้องตรงๆ ในที่สว่าง แล้วถ่ายใหม่' };
  if (faces.length > 1) return { ok: false, reason: 'พบหลายใบหน้า — ถ่ายเฉพาะตัวเองคนเดียว' };
  const f = faces[0], score = f.categories[0].score;
  if (f.boundingBox.width < w * 0.18) return { ok: false, reason: 'ใบหน้าเล็กเกินไป — ขยับเข้าใกล้กล้องอีกนิด' };
  if (score < 0.75) return { ok: false, reason: 'ใบหน้าไม่ชัด — ถ่ายในที่สว่างกว่านี้' };
  return { ok: true, score: Math.round(score * 100) / 100 };
}
